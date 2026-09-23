/**
 * service · 业务关卡减负（B-70）：批量放行 + 低风险抽检 + H1 负载仪表。
 *
 * 口径（去审批化后）：
 *  - 关卡放行 = approvals 行的手势（approve/edit/reject），仍走 review-console#decide（围栏/事件/幂等不变）；
 *  - 批量的只是"低风险且配额内"的关卡；L4 与 high_risk 一律逐条（planBatchRelease 硬约束）；
 *  - 每次批量在账本留一条 `gate.batch_release` 汇总事件（放了哪些、抽检了哪些、留待哪些、seed 与配额）；
 *  - H1 仪表（≤7 件/日、≤30 秒/件）从 approvals 表与事件账本实时算，不写死目标值。
 */
import type pg from "pg";
import { getAppPool, getGatewayPool } from "@workloom/db";
import { decide, planBatchRelease, evaluateGateLoad, type ReleaseCandidate, type BatchReleasePlan, type GateLoadVerdict } from "@workloom/base/review-console";
import type { MemberRole } from "@workloom/shared";
import { appendEventOn, serviceTx, svcQuery } from "./events.js";

/** 角色类型直接引用 review-console：新增角色（如 staff）不在这里硬编码漂移 */
type Actor = { memberNo: string; role: MemberRole; id: string };

export interface GateLoadMetrics extends GateLoadVerdict {
  pending: number;
  pendingByTier: Record<string, number>;
  decidedToday: number;
  avgDecisionSeconds: number | null;
  overdue24h: number;
  /** 近窗（默认 7 天）裁决明细，供前端画条 */
  decided7d: number;
  windowDays: number;
}

/** H1 负载仪表：今日裁决量 / 平均逐条时长 / 排队与超龄（全部来自 approvals 行与事件账本） */
export async function gateLoadMetrics(workspaceId: string, windowDays = 7): Promise<GateLoadMetrics> {
  const rows = await svcQuery<{
    pending: string; pending_l4: string; pending_l3: string; pending_l2: string;
    decided_today: string; decided_window: string; avg_seconds: string | null; overdue: string;
  }>(workspaceId,
    `SELECT
        count(*) FILTER (WHERE status='pending')::text AS pending,
        count(*) FILTER (WHERE status='pending' AND tier='l4_chairman')::text AS pending_l4,
        count(*) FILTER (WHERE status='pending' AND tier='l3_fleet')::text AS pending_l3,
        count(*) FILTER (WHERE status='pending' AND COALESCE(tier,'l2_captain') NOT IN ('l4_chairman','l3_fleet'))::text AS pending_l2,
        count(*) FILTER (WHERE status <> 'pending' AND decided_at >= date_trunc('day', now()))::text AS decided_today,
        count(*) FILTER (WHERE status <> 'pending' AND decided_at > now() - ($2 || ' days')::interval)::text AS decided_window,
        AVG(EXTRACT(EPOCH FROM (decided_at - created_at))) FILTER (
          WHERE status <> 'pending' AND decided_at > now() - ($2 || ' days')::interval
        )::text AS avg_seconds,
        count(*) FILTER (WHERE status='pending' AND created_at < now() - interval '24 hours')::text AS overdue
      FROM approvals WHERE workspace_id=$1`,
    [workspaceId, String(windowDays)]);
  const r = rows[0];
  const pendingByTier = {
    l4_chairman: Number(r?.pending_l4 ?? 0),
    l3_fleet: Number(r?.pending_l3 ?? 0),
    l2_captain: Number(r?.pending_l2 ?? 0),
  };
  const input = {
    pending: Number(r?.pending ?? 0),
    pendingByTier,
    decidedToday: Number(r?.decided_today ?? 0),
    avgDecisionSeconds: r?.avg_seconds === null || r?.avg_seconds === undefined ? null : Number(r.avg_seconds),
    overdue24h: Number(r?.overdue ?? 0),
  };
  return {
    ...input,
    ...evaluateGateLoad(input),
    decided7d: Number(r?.decided_window ?? 0),
    windowDays,
  };
}

export interface BatchReleaseResult {
  plan: BatchReleasePlan;
  released: string[];
  skipped: Array<{ id: string; reason: string }>;
  eventId: string | null;
}

/**
 * 批量放行（低风险 + 配额内 + 未被抽检）：
 *  ① 读待放行关卡（含 tier/high_risk/年龄）→ 纯函数规划；
 *  ② 对 autoRelease 逐条走 decide(approve)（与单条同一条链路，唯一差别是提案方是客户本人）；
 *  ③ 同事务写 `gate.batch_release` 汇总事件（含抽检名单与 seed：审计可复算）。
 */
export async function releaseGatesBatch(
  workspaceId: string, actor: Actor,
  opts: { quota?: number; sampleRate?: number; seed?: number } = {},
): Promise<BatchReleaseResult> {
  const pending = await svcQuery<{
    approval_id: string; tier: string | null; high_risk: boolean | null;
    title: string | null; age_hours: string;
  }>(workspaceId,
    `SELECT a.approval_id, a.tier,
            (a.snapshot->>'high_risk')::boolean AS high_risk,
            COALESCE(a.snapshot->>'title', e.payload->'decision'->>'action', a.approval_id) AS title,
            GREATEST(0, EXTRACT(EPOCH FROM (now() - a.created_at)) / 3600)::text AS age_hours
       FROM approvals a LEFT JOIN biz_events e ON e.event_id = a.event_id
      WHERE a.workspace_id=$1 AND a.status='pending'
      ORDER BY a.created_at ASC`,
    [workspaceId]);
  const candidates: ReleaseCandidate[] = pending.map((p) => ({
    approvalId: p.approval_id,
    tier: p.tier ?? "l2_captain",
    highRisk: p.high_risk === true,
    title: p.title ?? undefined,
    ageHours: Number(p.age_hours ?? 0),
  }));
  const today = await svcQuery<{ n: string }>(workspaceId,
    `SELECT count(*)::text AS n FROM approvals
      WHERE workspace_id=$1 AND status <> 'pending' AND decided_at >= date_trunc('day', now())`,
    [workspaceId]);
  const plan = planBatchRelease(candidates, { ...opts, todayReleased: Number(today[0]?.n ?? 0) });

  const app = getAppPool();
  const gateway = getGatewayPool();
  const released: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const c of plan.autoRelease) {
    try {
      const r = await decide(app, gateway, { tenantId: await tenantOf(workspaceId), workspaceId }, { memberNo: actor.memberNo, role: actor.role }, c.approvalId, { type: "approve" });
      if (r.deduped || r.status === "approved") released.push(c.approvalId);
      else skipped.push({ id: c.approvalId, reason: `状态 ${r.status}` });
    } catch (error) {
      skipped.push({ id: c.approvalId, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  // 汇总事件：放行清单 / 抽检清单 / 留待清单 / seed / 配额，一条事件可复盘整批
  const eventId = await serviceTx(workspaceId, async (client, scope) => {
    const ev = await appendEventOn(client, scope, { id: actor.memberNo, type: "human" }, {
      objectType: "approval_batch", objectId: `batch-${Date.now().toString(36)}`,
      action: "gate.batch_release",
      after: {
        released, releasedCount: released.length,
        sampled: plan.sampled.map((c) => c.approvalId),
        hold: plan.hold.map((c) => c.approvalId),
        quota: plan.quota, todayReleased: plan.todayReleased, sampleRate: plan.sampleRate, seed: plan.seed,
        rationale: plan.rationale, skipped,
      },
    });
    return ev.eventId;
  });

  return { plan, released, skipped, eventId };
}

async function tenantOf(workspaceId: string): Promise<string> {
  const rows = await svcQuery<{ tenant_id: string }>(workspaceId, `SELECT tenant_id FROM workspaces WHERE id=$1`, [workspaceId]);
  const tenantId = rows[0]?.tenant_id;
  if (!tenantId) throw new Error(`工作区不存在：${workspaceId}`);
  return tenantId;
}
