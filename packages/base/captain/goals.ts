/**
 * 目标与指标事实源（GOAL-KPI-01）。
 *
 * 背景（2026-09-29 审计实证）：闭环五要素里的「①目标」与「⑤反馈」没有生产者——
 *  - `goal.tracking` 只出现在 UI 文案与种子数据里，偏差节拍（`runDeviationBeat`）读不到任何数据，
 *    「偏差立项」在真实数据下永远空转；
 *  - `store.daily.summary` 只在测试里被注入，决策回测的「实际值」恒为 0，命中率没有意义；
 *  - 而且两个消费方（熔断节拍与回测节拍）此前都写死 `occ`/`adr` 这类**酒店专用**指标名，
 *    增长行业（有效询盘数、AI 引用率等）即使灌了指标也读不到。
 *
 * 本模块提供三个动作（全部走同一事务：状态与事件同一 COMMIT，D16）：
 *  1. `setGoal`：写入/更新目标（落 `profiles.archive.goals`，并广播 `goal.tracking`）；
 *  2. `ingestMetric`：写入一条指标（广播 `metric.daily`，并汇总为 `store.daily.summary` 供熔断/回测读取）；
 *  3. `refreshGoalTracking`：用最新指标值与目标值算出偏差（百分点），再广播一次 `goal.tracking`——
 *     这一步才让「偏差节拍」有输入（阈值 ±5pt）。
 *
 * 数据纪律：指标名与单位由调用方（行业包/客户）决定，本模块不预设任何行业指标；
 * 缺数据时不推断、不补零——`refreshGoalTracking` 找不到对应指标即如实返回 skipped。
 */
import type pg from "pg";
import { gatewayAppendOnClient } from "../workdata/gateway.js";
import type { Scope } from "./loop.js";

export interface GoalRecord {
  goal_id: string;
  metric: string;
  target: number;
  unit?: string;
  period_start: string;
  period_end: string;
  note?: string;
  created_by: string;
  created_at: string;
}

export interface GoalInput {
  metric: string;
  target: number;
  unit?: string;
  periodStart: string;
  periodEnd: string;
  note?: string;
  /** 省略时按 `goal-<metric>-<periodEnd>` 生成（同目标重复写入即幂等更新） */
  goalId?: string;
}

export interface MetricInput {
  metric: string;
  value: number;
  unit?: string;
  /** 指标归属时点（默认当前时间） */
  at?: string;
  /** 数据来源（real/demo/mock/derived 之外的来源标识，如平台名、连接器名） */
  source?: string;
}

/**
 * 偏差（百分点）：`(实际 - 目标) / 目标 × 100`，负=落后。
 * 目标为 0 时不做除法：实际也为 0 记 0，否则记 100（避免除零把偏差放大成无穷）。
 */
export function computeDeviationPt(target: number, actual: number): number {
  if (!Number.isFinite(target) || !Number.isFinite(actual)) return 0;
  if (target === 0) return actual === 0 ? 0 : 100;
  return Number((((actual - target) / Math.abs(target)) * 100).toFixed(1));
}

/**
 * 由一条指标生成 `store.daily.summary` 的载荷。
 * 行业无关：指标名原样作为键（熔断按宪章 `kpi_floor` 的键名匹配，回测按决策预期的 metric 名匹配）；
 * 同时保留 `occ`/`adr` 这类历史键的**透传**能力——调用方显式传酒店指标时键名不变。
 */
export function summaryPayloadFrom(metric: string, value: number, extra: Record<string, number> = {}): Record<string, number> {
  return { [metric]: value, ...extra, at_epoch: Math.floor(Date.now() / 1000) };
}

function goalIdOf(input: GoalInput): string {
  const raw = input.goalId ?? `goal-${input.metric}-${input.periodEnd}`;
  return raw.replace(/\s+/g, "-").slice(0, 120);
}

/* ================= 写入：目标 ================= */

export async function setGoal(
  app: pg.Pool,
  _gateway: pg.Pool,
  scope: Scope,
  by: string,
  input: GoalInput,
): Promise<{ eventId: string; goal: GoalRecord }> {
  if (input.metric.trim().length === 0) throw new Error("目标必须带指标名（metric）");
  if (!Number.isFinite(input.target)) throw new Error("目标值必须是有限数字（target）");
  const goal: GoalRecord = {
    goal_id: goalIdOf(input),
    metric: input.metric.trim(),
    target: input.target,
    ...(input.unit ? { unit: input.unit } : {}),
    period_start: input.periodStart,
    period_end: input.periodEnd,
    ...(input.note ? { note: input.note } : {}),
    created_by: by,
    created_at: new Date().toISOString(),
  };
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    // 目标落一 X 一档（profiles.archive.goals）：同 goal_id 覆盖，历史目标保留在事件账本里
    await client.query(
      `UPDATE profiles
          SET archive = jsonb_set(
                archive,
                '{goals}',
                (SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
                   FROM (
                     SELECT item FROM jsonb_array_elements(COALESCE(archive->'goals', '[]'::jsonb)) AS item
                      WHERE item->>'goal_id' <> $3
                     UNION ALL
                     SELECT $4::jsonb
                   ) merged),
                true),
              updated_at = now()
        WHERE workspace_id = $1 AND tenant_id = $2`,
      [scope.workspaceId, scope.tenantId, goal.goal_id, JSON.stringify(goal)],
    );
    const ev = await gatewayAppendOnClient(client, {
      tenantId: scope.tenantId, workspaceId: scope.workspaceId,
      actor: { id: by, type: "human" },
    }, {
      who: { type: "human", id: by },
      context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
      object: { type: "goal", id: goal.goal_id },
      decision: {
        action: "goal.tracking",
        params: { metric: goal.metric, target: goal.target, unit: goal.unit ?? "" },
        after: {
          goal_id: goal.goal_id,
          metric: goal.metric,
          target: goal.target,
          unit: goal.unit ?? "",
          period_start: goal.period_start,
          period_end: goal.period_end,
          status: "set",
        },
        basis: ["目标注入：闭环第一步（纲领第一条：方向必须由人注入）"],
      },
      rule_impact: [],
    } as never);
    await client.query("COMMIT");
    return { eventId: ev.eventId, goal };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/* ================= 写入：指标 ================= */

export async function ingestMetric(
  app: pg.Pool,
  _gateway: pg.Pool,
  scope: Scope,
  by: string,
  input: MetricInput,
): Promise<{ eventId: string; summaryEventId: string; summary: Record<string, number> }> {
  if (input.metric.trim().length === 0) throw new Error("指标必须带名称（metric）");
  if (!Number.isFinite(input.value)) throw new Error("指标值必须是有限数字（value）");
  const at = input.at ?? new Date().toISOString();
  const summary = summaryPayloadFrom(input.metric.trim(), input.value);
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const common = {
      who: { type: "system", id: "metrics-ingest" },
      context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: at, channel: "inapp" },
    } as const;
    const metricEvent = await gatewayAppendOnClient(client, {
      tenantId: scope.tenantId, workspaceId: scope.workspaceId,
      actor: { id: by, type: "human" },
    }, {
      ...common,
      object: { type: "metric", id: input.metric.trim() },
      decision: {
        action: "metric.daily",
        params: { unit: input.unit ?? "", source: input.source ?? "unspecified" },
        after: { metric: input.metric.trim(), value: input.value, at },
        basis: ["指标摄入：闭环第五步（反馈与对账）的输入"],
      },
      rule_impact: [],
    } as never);
    const summaryEvent = await gatewayAppendOnClient(client, {
      tenantId: scope.tenantId, workspaceId: scope.workspaceId,
      actor: { id: "metrics-ingest", type: "system" },
    }, {
      ...common,
      object: { type: "metric", id: "store.daily.summary" },
      decision: {
        action: "store.daily.summary",
        params: { source_metric: input.metric.trim() },
        after: summary,
        basis: ["日汇总投影：熔断节拍按宪章 kpi_floor 键名取数；回测节拍按决策预期 metric 名取数（行业无关）"],
      },
      rule_impact: [],
    } as never);
    await client.query("COMMIT");
    return { eventId: metricEvent.eventId, summaryEventId: summaryEvent.eventId, summary };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/* ================= 只读：取最新目标/指标 ================= */

/** 读取工作区最新目标（一 X 一档里的 goals 数组，取 created_at 最大的一条） */
export async function latestGoal(app: pg.Pool, scope: Scope): Promise<GoalRecord | undefined> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const r = await client.query<{ goal: GoalRecord | null }>(
      `SELECT (SELECT g FROM jsonb_array_elements(COALESCE(archive->'goals', '[]'::jsonb)) AS g
                ORDER BY g->>'created_at' DESC LIMIT 1) AS goal
         FROM profiles WHERE workspace_id=$1 AND tenant_id=$2`,
      [scope.workspaceId, scope.tenantId],
    );
    await client.query("COMMIT");
    return r.rows[0]?.goal ?? undefined;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** 读取某个指标的最新值（从 metric.daily 事件取，按 seq 倒序） */
export async function latestMetricValue(app: pg.Pool, scope: Scope, metric: string): Promise<number | undefined> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const r = await client.query<{ value: string | null }>(
      `SELECT payload->'decision'->'after'->>'value' AS value
         FROM biz_events
        WHERE workspace_id=$1 AND payload->'decision'->>'action'='metric.daily'
          AND payload->'decision'->'after'->>'metric'=$2
        ORDER BY seq DESC LIMIT 1`,
      [scope.workspaceId, metric],
    );
    await client.query("COMMIT");
    const raw = r.rows[0]?.value;
    if (raw === null || raw === undefined) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/* ================= 派生：偏差对账 ================= */

/**
 * 用最新目标与最新指标算出偏差并广播 `goal.tracking`（暴露 `deviation_pt` 供偏差节拍读取）。
 * 找不到目标或指标 → 如实 skipped（不造数）。
 */
export async function refreshGoalTracking(
  app: pg.Pool,
  _gateway: pg.Pool,
  scope: Scope,
): Promise<{ eventId: string; deviationPt: number; goal: GoalRecord; actual: number } | { skipped: string }> {
  const goal = await latestGoal(app, scope);
  if (!goal) return { skipped: "未设置目标（先调用 goals.set）" };
  const actual = await latestMetricValue(app, scope, goal.metric);
  if (actual === undefined) return { skipped: `指标 ${goal.metric} 尚无数据（先调用 metrics.ingest）` };
  const deviationPt = computeDeviationPt(goal.target, actual);
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const ev = await gatewayAppendOnClient(client, {
      tenantId: scope.tenantId, workspaceId: scope.workspaceId,
      actor: { id: "goal-tracker", type: "system" },
    }, {
      who: { type: "system", id: "goal-tracker" },
      context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
      object: { type: "goal", id: goal.goal_id },
      decision: {
        action: "goal.tracking",
        params: { metric: goal.metric, target: goal.target, actual, unit: goal.unit ?? "" },
        after: {
          goal_id: goal.goal_id,
          metric: goal.metric,
          target: goal.target,
          actual,
          deviation_pt: deviationPt,
          unit: goal.unit ?? "",
          period_start: goal.period_start,
          period_end: goal.period_end,
          status: "measured",
        },
        basis: [`目标 ${goal.target} / 实际 ${actual} → 偏差 ${deviationPt}pt（偏差节拍阈值 ±5pt）`],
      },
      rule_impact: [],
    } as never);
    await client.query("COMMIT");
    return { eventId: ev.eventId, deviationPt, goal, actual };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
