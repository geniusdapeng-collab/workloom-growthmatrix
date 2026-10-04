/**
 * inspection · 一键派单与回链（F9.3，E9.3，L9.3 幂等）
 *  - 以异常事件为输入唤起对应业务 Agent 建任务（threads 行 + inspect.dispatch 事件 links 回链）
 *  - 处理结果回链异常事件：成功 → inspect.resolved；失败 → 升级一级严重度 + 转需介入（E9.3）
 *  - 幂等：同一异常事件重复派单/重复回链只处理首次（不重复建单、不重复推送）
 */
import type pg from "pg";
import { gatewayAppendOnClient } from "../workdata/gateway.js";
import { insertWithReadableId, THREAD_ID_SOURCE } from "../workdata/readable-id.js";
import type { Severity } from "./checks.js";
import { withInspectionTransaction } from "./transaction.js";

interface Scope { tenantId: string; workspaceId: string }

export class DispatchError extends Error {
  constructor(public readonly code: "ANOMALY_NOT_FOUND" | "ALREADY_HANDLED" | "THREAD_MISMATCH", message: string) {
    super(message);
    this.name = "DispatchError";
  }
}

/** 严重度升一级（E9.3）：low→medium→high；high 保持 high 并转需介入 */
export function escalateSeverity(s: Severity): Severity {
  return s === "low" ? "medium" : "high";
}

/** 事务内事件留痕（D16：调用方持有事务，与业务写同一 COMMIT） */
async function emitInTx(
  client: pg.PoolClient,
  scope: Scope,
  actorId: string,
  actorType: "human" | "system",
  decision: Record<string, unknown>,
  object: { type: string; id?: string },
  links?: string[],
  sessionId?: string | null,
): Promise<string> {
  const r = await gatewayAppendOnClient(client, {
    tenantId: scope.tenantId, workspaceId: scope.workspaceId,
    actor: { id: actorId, type: actorType },
    sessionId: sessionId ?? null,
  }, {
    who: { type: actorType, id: actorId },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
    object,
    decision: decision as never,
    rule_impact: [],
    links,
  });
  return r.eventId;
}

/** 查异常事件（本工作区内；越权返回空——L7.1 口径由调用层 RLS 保证） */
async function getAnomalyEvent(
  client: pg.PoolClient,
  scope: Scope,
  anomalyEventId: string,
): Promise<{ eventId: string; summary: string; severity: Severity; objectType: string; objectId?: string } | null> {
  const r = await client.query<{
    event_id: string;
    payload: { decision: { after?: { summary?: string; severity?: Severity } }; object: { type: string; id?: string } };
  }>(
    `SELECT event_id, payload FROM biz_events
     WHERE tenant_id=$1 AND workspace_id=$2 AND event_id=$3 AND payload->'decision'->>'action' = 'inspect.anomaly'`,
    [scope.tenantId, scope.workspaceId, anomalyEventId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    eventId: row.event_id,
    summary: row.payload.decision.after?.summary ?? "",
    severity: row.payload.decision.after?.severity ?? "low",
    objectType: row.payload.object.type,
    objectId: row.payload.object.id,
  };
}

/** 幂等检查：该异常是否已有派单/回链（L9.3 同源纪律：同事件不重复推送/建单） */
async function findExisting(client: pg.PoolClient, scope: Scope, anomalyEventId: string, actions: string[]) {
  const r = await client.query<{ event_id: string; payload: { decision: { after?: { threadId?: string } } } }>(
    `SELECT event_id,payload FROM biz_events
     WHERE tenant_id=$1 AND workspace_id=$2 AND payload->'decision'->>'action' = ANY($3::text[])
       AND payload->'links' @> $4::jsonb ORDER BY seq ASC LIMIT 1`,
    [scope.tenantId, scope.workspaceId, actions, JSON.stringify([anomalyEventId])],
  );
  return r.rows[0] ?? null;
}

async function lockAnomaly(client: pg.PoolClient, scope: Scope, anomalyEventId: string): Promise<void> {
  // Dispatch and either terminal action share one key; the event-chain lock is acquired later.
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",
    [JSON.stringify(["inspection-anomaly", scope.tenantId, scope.workspaceId, anomalyEventId])]);
}

/**
 * 一键派单（F9.3）：异常事件 → 建 thread（queued，由 runtime 拉取/立即执行）+ 派单留痕
 * 处理结果由 resolveAnomaly 回链（线程完成/失败后调用）。
 */
export async function dispatchFromAnomaly(
  app: pg.Pool,
  _gateway: pg.Pool,
  scope: Scope,
  input: { anomalyEventId: string; presetKey: string; by: string },
): Promise<{ threadId: string; eventId: string; deduped: boolean }> {
  return withInspectionTransaction(app, scope, async client => {
    await lockAnomaly(client, scope, input.anomalyEventId);
    const anomaly = await getAnomalyEvent(client, scope, input.anomalyEventId);
    if (!anomaly) {
      throw new DispatchError("ANOMALY_NOT_FOUND", `异常事件 ${input.anomalyEventId} 不存在或不属本工作区`);
    }
    // 幂等：已派过单 → 返回原单（不重复建）
    const existing = await findExisting(client, scope, input.anomalyEventId, ["inspect.dispatch"]);
    if (existing) {
      const threadId = existing.payload.decision.after?.threadId;
      if (!threadId) throw new DispatchError("ALREADY_HANDLED", "派单回执缺少任务绑定，已停止重复建单");
      return { threadId, eventId: existing.event_id, deduped: true };
    }

    const title = `【巡检派单】${anomaly.summary}`;
    // D16（#1/A）：线程创建与派单事件同一事务同一 COMMIT
    // 号源走 SECURITY DEFINER 函数（0016：全库最大值绕 RLS，跨工作区不撞号）；
    // GR-02（2026-09-29 第二次修复）：与 tRPC 派遣同口径走 insertWithReadableId（纯 nextval + SAVEPOINT 换号）
    const threadId = (await insertWithReadableId(client, THREAD_ID_SOURCE, async (id) => {
      await client.query(
        `INSERT INTO threads (id, tenant_id, workspace_id, title, mode, status, created_by, agent_id)
         VALUES ($1,$2,$3,$4,'quest','queued',$5,$6)`,
        [id, scope.tenantId, scope.workspaceId, title, input.by, input.presetKey],
      );
      return id;
    })).id;
    const eventId = await emitInTx(client, scope, input.by, "human", {
      action: "inspect.dispatch",
      after: { threadId, anomalyEventId: input.anomalyEventId, presetKey: input.presetKey, severity: anomaly.severity },
      basis: ["一键派单：以异常事件为输入唤起业务 Agent（F9.3）", "处理结果将回链异常事件（F9.3/E9.3）"],
      // #38 修复：派单事件挂 sessionId=threadId——此前仅 links 回链，
      // threads.events（按 session_id 投影线程事件流）看不到派单事件，P2 行动消息流缺环
    }, { type: anomaly.objectType, id: anomaly.objectId }, [input.anomalyEventId], threadId);
    return { threadId, eventId, deduped: false };
  });
}

/**
 * 处理结果回链（F9.3/E9.3）：
 *  - ok=true  → inspect.resolved（回链异常事件 + 线程）
 *  - ok=false → 升级一级严重度 + 转需介入（inspect.escalated）
 * 幂等：同一异常重复回链只处理首次（L9.3）
 */
export async function resolveAnomaly(
  app: pg.Pool,
  _gateway: pg.Pool,
  scope: Scope,
  input: { anomalyEventId: string; threadId: string; ok: boolean; note?: string; by: string },
): Promise<{ eventId: string; deduped: boolean; escalatedTo?: Severity }> {
  return withInspectionTransaction(app, scope, async client => {
    await lockAnomaly(client, scope, input.anomalyEventId);
    const anomaly = await getAnomalyEvent(client, scope, input.anomalyEventId);
    if (!anomaly) {
      throw new DispatchError("ANOMALY_NOT_FOUND", `异常事件 ${input.anomalyEventId} 不存在或不属本工作区`);
    }
    const dispatched = await findExisting(client, scope, input.anomalyEventId, ["inspect.dispatch"]);
    const thread = await client.query("SELECT id FROM threads WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3",
      [scope.tenantId, scope.workspaceId, input.threadId]);
    if (dispatched?.payload.decision.after?.threadId !== input.threadId || !thread.rows[0]) {
      throw new DispatchError("THREAD_MISMATCH", "任务不存在于本工作区或没有绑定该异常，已拒绝回链");
    }
    const existing = await findExisting(client, scope, input.anomalyEventId, ["inspect.resolved", "inspect.escalated"]);
    if (existing) return { eventId: existing.event_id, deduped: true };

    if (input.ok) {
      const eventId = await emitInTx(client, scope, input.by, "system", {
        action: "inspect.resolved",
        after: { anomalyEventId: input.anomalyEventId, threadId: input.threadId, note: input.note ?? "" },
        basis: ["处理结果回链异常事件（F9.3）"],
      }, { type: anomaly.objectType, id: anomaly.objectId }, [input.anomalyEventId, input.threadId]);
      return { eventId, deduped: false };
    }

    const escalatedTo = escalateSeverity(anomaly.severity);
    const eventId = await emitInTx(client, scope, input.by, "system", {
      action: "inspect.escalated",
      after: {
        anomalyEventId: input.anomalyEventId, threadId: input.threadId,
        fromSeverity: anomaly.severity, toSeverity: escalatedTo,
        need_human: true, note: input.note ?? "",
      },
      basis: ["派单后处理失败：回链并升级一级严重度，转需介入（E9.3）"],
    }, { type: anomaly.objectType, id: anomaly.objectId }, [input.anomalyEventId, input.threadId]);
    return { eventId, deduped: false, escalatedTo };
  });
}
