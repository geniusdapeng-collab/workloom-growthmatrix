/**
 * service · 冲突仲裁对象（B-39）：多 Agent 对同一资源给出不同方案时的对象化裁决。
 *
 * 纪律：
 *  - 对象 `conflict_arbitration` 由事件溯源（conflict.raise / conflict.arbitrate / conflict.resolve），
 *    读模型只由 `reduceConflictStatus` 归约，不采信客户端声明的状态；
 *  - 裁决复用 captain 的单一裁决器 `arbitrate()`（硬边界 → 证据强度 → 归因贡献 → 升级），
 *    本服务不另设权力、不改变裁决规则；
 *  - 升级（escalate）必须在同一 COMMIT 落一条 L4 业务关卡行（approvals），
 *    否则"升级了但没人看得到"——无回执不算完成；
 *  - 只增不改：不做删除，只有 resolve 收口。
 */
import { z } from "zod";
import {
  arbitrate, reduceConflictStatus,
  type Conflict, type ConflictStatus, type ConflictVerdict,
} from "@workloom/base/captain";
import { appendEventOn, serviceTx, svcQuery } from "./events.js";

type Actor = { id: string; type: "human" | "agent" | "system"; version?: string };

export const ConflictRaiseSchema = z.object({
  type: z.enum(["budget", "schedule", "attribution"]),
  domain: z.string().trim().min(1).max(80),
  summary: z.string().trim().min(1).max(2000),
  parties: z.array(z.object({
    agent: z.string().trim().min(1).max(120),
    proposal: z.string().trim().min(1).max(600),
    evidence: z.enum(["confirmed", "reported", "inferred"]),
    contribution: z.number().min(0).max(1).optional(),
  })).min(2).max(8),
  involvesMoney: z.boolean().optional(),
  involvesCommitment: z.boolean().optional(),
  overBand: z.boolean().optional(),
});
export type ConflictRaiseInput = z.infer<typeof ConflictRaiseSchema>;

export class ConflictError extends Error {
  constructor(public readonly code: "BAD_INPUT" | "NOT_FOUND" | "BAD_STATE", message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export interface ConflictArbitration {
  id: string;
  type: Conflict["type"];
  domain: string;
  summary: string;
  parties: Conflict["parties"];
  involvesMoney: boolean;
  involvesCommitment: boolean;
  overBand: boolean;
  status: ConflictStatus;
  verdict: ConflictVerdict | null;
  winner: string | null;
  rationale: string;
  memo: string;
  raisedBy: string;
  resolvedBy: string | null;
  resolution: string | null;
  /** 升级场景的业务关卡 id（approvals 行）；未升级为 null */
  approvalId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface EventRow {
  [key: string]: unknown;
  event_id: string;
  created_at: unknown;
  payload: {
    who?: { id?: string };
    decision?: { action?: string; after?: Record<string, unknown> | null };
  } | null;
}

const iso = (value: unknown): string => {
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
};

const str = (value: unknown): string => (value == null ? "" : String(value));

function toConflict(events: EventRow[]): ConflictArbitration | null {
  if (events.length === 0) return null;
  const first = events[0]!;
  const base = (first.payload?.decision?.after ?? {}) as Record<string, unknown>;
  const reduced = reduceConflictStatus(events.map((e) => ({
    action: str(e.payload?.decision?.action),
    after: (e.payload?.decision?.after ?? null) as { verdict?: string | null; status?: string | null } | null,
  })));
  if (!reduced) return null;
  const last = events[events.length - 1]!;
  const arbitrateRow = [...events].reverse().find((e) => str(e.payload?.decision?.action) === "conflict.arbitrate") ?? null;
  const resolveRow = [...events].reverse().find((e) => str(e.payload?.decision?.action) === "conflict.resolve") ?? null;
  const arbitrateAfter = arbitrateRow?.payload?.decision?.after ?? null;
  const resolveAfter = resolveRow?.payload?.decision?.after ?? null;
  return {
    id: str(base.id),
    type: str(base.type) as Conflict["type"],
    domain: str(base.domain),
    summary: str(base.summary),
    parties: (base.parties ?? []) as Conflict["parties"],
    involvesMoney: base.involvesMoney === true,
    involvesCommitment: base.involvesCommitment === true,
    overBand: base.overBand === true,
    status: reduced.status,
    verdict: reduced.verdict,
    winner: arbitrateAfter?.winner ? str(arbitrateAfter.winner) : null,
    rationale: str(arbitrateAfter?.rationale ?? base.rationale),
    memo: str(arbitrateAfter?.memo ?? base.memo),
    raisedBy: str(first.payload?.who?.id),
    resolvedBy: resolveAfter ? str(resolveRow?.payload?.who?.id) : null,
    resolution: resolveAfter ? str(resolveAfter.resolution) : null,
    approvalId: arbitrateAfter?.approvalId ? str(arbitrateAfter.approvalId) : null,
    createdAt: iso(first.created_at),
    updatedAt: iso(last.created_at),
  };
}

async function conflictEvents(workspaceId: string, conflictId?: string): Promise<EventRow[]> {
  const params: unknown[] = [workspaceId];
  let where = `workspace_id=$1 AND payload->'object'->>'type'='conflict_arbitration'
    AND payload->'decision'->>'action' LIKE 'conflict.%'`;
  if (conflictId) {
    params.push(conflictId);
    where += ` AND payload->'object'->>'id'=$2`;
  }
  return svcQuery<EventRow>(workspaceId,
    `SELECT event_id, created_at, payload FROM biz_events WHERE ${where} ORDER BY seq ASC LIMIT 2000`, params);
}

/** 登记冲突（对象化入口）：两方以上提案 + 硬边界标记，一步落到 raised。 */
export async function raiseConflict(
  workspaceId: string, actor: Actor, input: ConflictRaiseInput,
): Promise<ConflictArbitration> {
  const parsed = ConflictRaiseSchema.safeParse(input);
  if (!parsed.success) {
    throw new ConflictError("BAD_INPUT", parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}：${i.message}`).join("；"));
  }
  const agents = new Set(parsed.data.parties.map((p) => p.agent));
  if (agents.size !== parsed.data.parties.length) {
    throw new ConflictError("BAD_INPUT", "同一岗位不能在同一冲突里占多方（提案人必须互不相同）");
  }
  const id = `CF-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const at = new Date().toISOString();
  const record = {
    type: parsed.data.type, domain: parsed.data.domain, summary: parsed.data.summary,
    parties: parsed.data.parties,
    involvesMoney: parsed.data.involvesMoney === true,
    involvesCommitment: parsed.data.involvesCommitment === true,
    overBand: parsed.data.overBand === true,
  } satisfies Conflict & { involvesMoney: boolean; involvesCommitment: boolean; overBand: boolean };
  const outcome = arbitrate(record);
  await serviceTx(workspaceId, async (client, scope) => {
    await appendEventOn(client, scope, actor, {
      objectType: "conflict_arbitration", objectId: id, action: "conflict.raise",
      after: {
        id, ...record, status: "raised", verdict: null, winner: null,
        rationale: outcome.rationale, memo: outcome.memo,
        raisedBy: actor.id, resolution: null, approvalId: null, createdAt: at, updatedAt: at,
      },
    });
  });
  return {
    id, ...record, status: "raised", verdict: null, winner: null,
    rationale: outcome.rationale, memo: outcome.memo, raisedBy: actor.id,
    resolvedBy: null, resolution: null, approvalId: null, createdAt: at, updatedAt: at,
  };
}

export async function getConflict(workspaceId: string, conflictId: string): Promise<ConflictArbitration | null> {
  return toConflict(await conflictEvents(workspaceId, conflictId));
}

export async function listConflicts(
  workspaceId: string, filter: { status?: ConflictStatus; limit?: number } = {},
): Promise<ConflictArbitration[]> {
  const rows = await conflictEvents(workspaceId);
  const byId = new Map<string, EventRow[]>();
  for (const row of rows) {
    const payload = row.payload as { object?: { id?: string } } | null;
    const id = str((payload?.object as { id?: string } | undefined)?.id);
    if (!id) continue;
    const list = byId.get(id) ?? [];
    list.push(row);
    byId.set(id, list);
  }
  const all = [...byId.values()]
    .map((events) => toConflict(events))
    .filter((c): c is ConflictArbitration => c !== null)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const filtered = filter.status ? all.filter((c) => c.status === filter.status) : all;
  return filtered.slice(0, filter.limit ?? 50);
}

/**
 * 裁决：跑单一裁决器；grant → granted；escalate → escalated **且同事务落 L4 业务关卡**。
 * 幂等：同一冲突已 arbitrate 过则按 BAD_STATE 拒绝（避免重复关卡行）。
 */
export async function arbitrateConflict(
  workspaceId: string, actor: Actor, conflictId: string,
): Promise<{ conflict: ConflictArbitration; eventId: string; approvalId: string | null }> {
  const current = await getConflict(workspaceId, conflictId);
  if (!current) throw new ConflictError("NOT_FOUND", `冲突不存在：${conflictId}`);
  if (current.status !== "raised") {
    throw new ConflictError("BAD_STATE", `状态 ${current.status} 不允许动作 arbitrate（只能裁决 raised 冲突）`);
  }
  const record: Conflict = {
    type: current.type, domain: current.domain, summary: current.summary, parties: current.parties,
    involvesMoney: current.involvesMoney, involvesCommitment: current.involvesCommitment, overBand: current.overBand,
  };
  const outcome = arbitrate(record);
  const approvalId = outcome.verdict === "escalate" ? `apr-${conflictId.toLowerCase()}` : null;
  const at = new Date().toISOString();
  const eventId = await serviceTx(workspaceId, async (client, scope) => {
    const ev = await appendEventOn(client, scope, actor, {
      objectType: "conflict_arbitration", objectId: conflictId, action: "conflict.arbitrate",
      after: {
        status: outcome.verdict === "grant" ? "granted" : "escalated",
        verdict: outcome.verdict, winner: outcome.winner ?? null,
        rationale: outcome.rationale, memo: outcome.memo,
        approvalId, updatedAt: at,
      },
    });
    if (approvalId) {
      // L4 业务关卡（升级即入队；UNIQUE(event_id, channel) 保证幂等，L5.3）
      await client.query(
        `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, tier, snapshot)
         VALUES ($1,$2,$3,$4,'inapp','pending','l4_chairman',$5)
         ON CONFLICT (event_id, channel) DO NOTHING`,
        [approvalId, scope.tenantId, scope.workspaceId, ev.eventId,
          JSON.stringify({
            action: "conflict.arbitrate", title: `冲突待裁定：${current.summary}`.slice(0, 200),
            high_risk: true, conflict_id: conflictId,
            after: { verdict: outcome.verdict, winner: outcome.winner ?? null, memo: outcome.memo },
          })],
      );
    }
    return ev.eventId;
  });
  return {
    conflict: {
      ...current,
      status: outcome.verdict === "grant" ? "granted" : "escalated",
      verdict: outcome.verdict, winner: outcome.winner ?? null,
      rationale: outcome.rationale, memo: outcome.memo, approvalId, updatedAt: at,
    },
    eventId, approvalId,
  };
}

/** 升级后的人审收口：只有 escalated 可 resolve（结论 + 文本留痕）。 */
export async function resolveConflict(
  workspaceId: string, actor: Actor, conflictId: string, input: { resolution: string },
): Promise<{ conflict: ConflictArbitration; eventId: string }> {
  const resolution = input.resolution?.trim();
  if (!resolution) throw new ConflictError("BAD_INPUT", "resolve 必须给出结论文本（可复现理由）");
  if (resolution.length > 2000) throw new ConflictError("BAD_INPUT", "结论文本超过 2000 字");
  const current = await getConflict(workspaceId, conflictId);
  if (!current) throw new ConflictError("NOT_FOUND", `冲突不存在：${conflictId}`);
  if (current.status !== "escalated") {
    throw new ConflictError("BAD_STATE", `状态 ${current.status} 不允许动作 resolve（未升级的冲突由裁决直接收口）`);
  }
  const at = new Date().toISOString();
  const eventId = await serviceTx(workspaceId, async (client, scope) => {
    const ev = await appendEventOn(client, scope, actor, {
      objectType: "conflict_arbitration", objectId: conflictId, action: "conflict.resolve",
      after: { status: "resolved", resolution, resolvedBy: actor.id, updatedAt: at },
    });
    return ev.eventId;
  });
  return {
    conflict: { ...current, status: "resolved", resolution, resolvedBy: actor.id, updatedAt: at },
    eventId,
  };
}
