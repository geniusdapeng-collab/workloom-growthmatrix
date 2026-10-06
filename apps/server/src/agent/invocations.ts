/** Durable call ownership. HTTP inputs and headers never create AgentInvocationRef. */
import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { TRPCError } from "@trpc/server";
import { gatewayAppendOnClient } from "@workloom/base/workdata";

export interface AgentScope { tenantId: string; workspaceId: string; memberNo: string }
export interface AgentInvocationRef { id: string; ownerToken: string; memberNo: string; action: "task.dispatch" | "film.start" }
export type AgentAction = "task.dispatch" | "task.cancel" | "film.start";
export interface AgentInvocation extends pg.QueryResultRow {
  id: string; tenant_id: string; workspace_id: string; member_no: string;
  action: AgentAction; input_sha256: string; request_meta: Record<string, unknown>;
  state: "reserved" | "linked" | "resolved" | "failed" | "unknown" | "cancelled";
  owner_token: string; entity_kind: "thread" | "film" | null; entity_id: string | null;
  event_id: string | null; result: Record<string, unknown> | null; failure_code: string | null;
  created_at: Date; updated_at: Date;
}

/** Canonical JSON is independent of caller property ordering; only parsed schemas reach here. */
export function agentCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(agentCanonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${agentCanonicalJson(item)}`).join(",")}}`;
}
export const agentInputHash = (action: AgentAction, input: unknown): string =>
  createHash("sha256").update(agentCanonicalJson({ action, input })).digest("hex");

export async function agentScopeOnClient(client: pg.PoolClient, scope: AgentScope): Promise<void> {
  await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.workspace_id',$2,true),set_config('app.member_no',$3,true)",
    [scope.tenantId, scope.workspaceId, scope.memberNo]);
}

/** Called BEFORE the workspace/project lock, on the same connection as creation. */
export async function lockAgentInvocation(client: pg.PoolClient, scope: { tenantId: string; workspaceId: string }, ref: AgentInvocationRef): Promise<void> {
  await agentScopeOnClient(client, { ...scope, memberNo: ref.memberNo });
  const rows = await client.query<AgentInvocation>(
    `SELECT * FROM agent_invocations WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND member_no=$4 FOR UPDATE`,
    [ref.id, scope.tenantId, scope.workspaceId, ref.memberNo]);
  const row = rows.rows[0];
  if (!row || row.owner_token !== ref.ownerToken || row.action !== ref.action || row.state !== "reserved") {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "调用已取消、已绑定或所有权不符，拒绝重复建档" });
  }
}

export async function linkAgentInvocation(client: pg.PoolClient, ref: AgentInvocationRef, entityKind: "thread" | "film", entityId: string, eventId: string): Promise<void> {
  const rows = await client.query(
    `UPDATE agent_invocations SET state='linked',entity_kind=$3,entity_id=$4,event_id=$5,updated_at=now()
      WHERE id=$1 AND owner_token=$2 AND member_no=$6 AND action=$7 AND state='reserved' RETURNING id`,
    [ref.id, ref.ownerToken, entityKind, entityId, eventId, ref.memberNo, ref.action]);
  if (rows.rowCount !== 1) throw new TRPCError({ code: "CONFLICT", message: "调用绑定未落账，拒绝无回执建档" });
}

export class AgentInvocationLedger {
  constructor(private readonly pool: pg.Pool, readonly scope: AgentScope) {}

  async transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query("BEGIN");
      await agentScopeOnClient(client, this.scope);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) {
        discard = true;
        throw new AggregateError([error, rollbackError], "agent-invocation-rollback-failed");
      }
      throw error;
    } finally { client.release(discard); }
  }

  async claim(action: AgentAction, key: string, hash: string, meta: Record<string, unknown> = {}): Promise<{ row: AgentInvocation; owner: boolean }> {
    return this.transaction(async (client) => {
      const result = await client.query<AgentInvocation>(
        `INSERT INTO agent_invocations (id,tenant_id,workspace_id,member_no,idempotency_key,action,input_sha256,request_meta,owner_token)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
          ON CONFLICT (tenant_id,workspace_id,member_no,idempotency_key) DO NOTHING RETURNING *`,
        [randomUUID(), this.scope.tenantId, this.scope.workspaceId, this.scope.memberNo, key, action, hash, JSON.stringify(meta), randomUUID()]);
      const owner = result.rows[0];
      if (owner) return { row: owner, owner: true };
      const previous = await client.query<AgentInvocation>(
        `SELECT * FROM agent_invocations WHERE tenant_id=$1 AND workspace_id=$2 AND member_no=$3 AND idempotency_key=$4`,
        [this.scope.tenantId, this.scope.workspaceId, this.scope.memberNo, key]);
      const row = previous.rows[0];
      if (!row) throw new TRPCError({ code: "CONFLICT", message: "调用并发事实未能读回，请用原请求键查询" });
      if (row.action !== action || row.input_sha256 !== hash) {
        throw new TRPCError({ code: "CONFLICT", message: "同一 idempotencyKey 已绑定另一组参数或动作" });
      }
      return { row, owner: false };
    });
  }

  async read(id: string): Promise<AgentInvocation> {
    return this.transaction(async (client) => {
      const result = await client.query<AgentInvocation>(
        `SELECT * FROM agent_invocations WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND member_no=$4`,
        [id, this.scope.tenantId, this.scope.workspaceId, this.scope.memberNo]);
      if (!result.rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "调用不存在或不属于当前成员" });
      return result.rows[0];
    });
  }

  async finish(row: AgentInvocation, result: Record<string, unknown> | null, failure?: { code: string; uncertain: boolean }): Promise<void> {
    await this.transaction(async (client) => {
      // A linked entity always wins over a later exception/timeout. Never detach or reexecute it.
      await client.query(
        `UPDATE agent_invocations SET state=CASE WHEN state='linked' THEN state ELSE $3 END,
          result=$4::jsonb,failure_code=CASE WHEN state='linked' THEN failure_code ELSE $5 END,updated_at=now()
          WHERE id=$1 AND owner_token=$2 AND state IN ('reserved','linked') AND result IS NULL`,
        [row.id, row.owner_token, failure ? failure.uncertain ? "unknown" : "failed" : "resolved",
          JSON.stringify(result), failure?.code ?? null]);
    });
  }

  /** Cancellation and its receipt share one transaction; creation locks this same target first. */
  async cancel(owner: AgentInvocation, targetId: string): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const own = await client.query<AgentInvocation>("SELECT * FROM agent_invocations WHERE id=$1 AND owner_token=$2 AND state='reserved' FOR UPDATE",
        [owner.id, owner.owner_token]);
      if (!own.rows[0] || own.rows[0].action !== "task.cancel") throw new TRPCError({ code: "CONFLICT", message: "取消调用所有权已变化" });
      const target = await client.query<AgentInvocation>("SELECT * FROM agent_invocations WHERE id=$1 AND member_no=$2 FOR UPDATE", [targetId, this.scope.memberNo]);
      const row = target.rows[0];
      if (!row || row.action !== "task.dispatch") throw new TRPCError({ code: "NOT_FOUND", message: "任务调用不存在或不属于当前成员" });
      let result: Record<string, unknown>;
      if (row.state === "reserved") {
        if (row.request_meta.cancellable === false) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "影片异步管线没有可核验的停止机制，不能承诺取消" });
        await client.query("UPDATE agent_invocations SET state='cancelled',updated_at=now() WHERE id=$1 AND state='reserved'", [row.id]);
        result = { invocationId: row.id, state: "cancelled", cancelledBeforeCreation: true, rollbackExternalActions: false };
      } else if (row.entity_kind === "thread" && row.entity_id) {
        const threads = await client.query<{ status: string; mode: string }>("SELECT status,mode FROM threads WHERE id=$1 AND workspace_id=$2 FOR UPDATE", [row.entity_id, this.scope.workspaceId]);
        const thread = threads.rows[0];
        if (!thread) throw new TRPCError({ code: "NOT_FOUND", message: "已绑定任务没有可读的实体回执" });
        const terminal = ["completed", "failed", "cancelled"].includes(thread.status);
        if (!terminal && (thread.mode === "ask" || row.request_meta.cancellable === false)) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "即时回答或影片管线当前不支持可核验取消" });
        }
        if (!terminal) {
          await client.query("UPDATE threads SET status='cancelled',closed_at=now(),updated_at=now() WHERE id=$1 AND workspace_id=$2 AND status NOT IN ('completed','failed','cancelled')",
            [row.entity_id, this.scope.workspaceId]);
          await client.query("UPDATE agent_invocations SET state='cancelled',updated_at=now() WHERE id=$1 AND state='linked'", [row.id]);
        }
        result = { invocationId: row.id, threadId: row.entity_id, state: terminal ? thread.status : "cancelled",
          alreadyTerminal: terminal, rollbackExternalActions: false, stopping: "before-next-quest-step" };
      } else {
        result = { invocationId: row.id, state: row.state, alreadyTerminal: true, rollbackExternalActions: false };
      }
      const event = await gatewayAppendOnClient(client, {
        tenantId: this.scope.tenantId, workspaceId: this.scope.workspaceId, actor: { id: this.scope.memberNo, type: "human" },
        ...(row.entity_id ? { sessionId: row.entity_id } : {}),
      }, {
        who: { type: "human", id: this.scope.memberNo },
        context: { tenant_id: this.scope.tenantId, workspace_id: this.scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
        object: { type: "agent_invocation", id: row.id }, decision: { action: "thread.cancel", after: result }, rule_impact: [],
      });
      await client.query("UPDATE agent_invocations SET state='resolved',result=$3::jsonb,event_id=$4,updated_at=now() WHERE id=$1 AND owner_token=$2 AND state='reserved'",
        [owner.id, owner.owner_token, JSON.stringify(result), event.eventId]);
      return result;
    });
  }
}
