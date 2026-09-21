/**
 * bundles/p2-ops —— P2 条件岗运营指标与退场判定（SCALE-07 / SCALE-08）
 *
 * 背景：P2 条件岗（生命周期增长官/渠道增长官）激活走 L4，但此前「激活后怎么算干得好、
 * 什么条件下退场」没有定义。岗位定义（preset 透传字段）里声明 ops_metrics 与 exit_conditions，
 * 本模块把「周度指标序列 → keep / watch / exit_proposal」变成确定性纯函数，供编制周报引用。
 *
 * 纪律：
 *  - 未取数不等于达标：所有指标都缺 → no_data（周报如实标注，不虚报 keep）；
 *  - 退场只在连续低于目标达到声明周数时提案（提案≠自动停用，仍走 L4）；
 *  - 缺指标的周不参与连续计数（避免用缺失数据制造退场理由）。
 */

export interface P2MetricDef {
  key: string;
  label: string;
  target: number;
  direction: "gte" | "lte";
  windowWeeks: number;
}

export interface P2ExitCondition {
  metric: string;
  consecutiveBelow: number;
  action: string;
}

export interface P2RoleDef {
  role: string;
  label: string;
  activationGate: string | null;
  metrics: P2MetricDef[];
  exitConditions: P2ExitCondition[];
  reviewCadence: string;
}

export interface P2Week {
  /** ISO 周标识（如 2026-W38）或日期字符串，按时间升序传入 */
  week: string;
  values: Record<string, number>;
}

export type P2Status = "keep" | "watch" | "exit_proposal" | "no_data";

export interface P2Evaluation {
  role: string;
  label: string;
  status: P2Status;
  reasons: string[];
  missingMetrics: string[];
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 从 agents.meta（装配时透传的完整 preset）解析 P2 运营声明；非 P2 岗返回 null。 */
export function parseP2RoleFromMeta(presetKey: string, meta: unknown): P2RoleDef | null {
  if (!meta || typeof meta !== "object") return null;
  const m = meta as Record<string, unknown>;
  const rawMetrics = Array.isArray(m.ops_metrics) ? m.ops_metrics : null;
  if (!rawMetrics || rawMetrics.length === 0) return null;
  const metrics: P2MetricDef[] = [];
  for (const item of rawMetrics) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const key = typeof row.key === "string" ? row.key.trim() : "";
    const label = typeof row.label === "string" ? row.label.trim() : key;
    const target = num(row.target);
    const direction = row.direction === "lte" ? "lte" : "gte";
    const windowWeeks = num(row.window_weeks) ?? 4;
    if (!key || target === null) continue;
    metrics.push({ key, label, target, direction, windowWeeks });
  }
  if (metrics.length === 0) return null;
  const exitConditions: P2ExitCondition[] = (Array.isArray(m.exit_conditions) ? m.exit_conditions : [])
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      const metric = typeof row.metric === "string" ? row.metric.trim() : "";
      const consecutiveBelow = num(row.consecutive_below);
      const action = typeof row.action === "string" ? row.action.trim() : "退场提案";
      if (!metric || consecutiveBelow === null || consecutiveBelow < 1) return [];
      return [{ metric, consecutiveBelow, action }];
    });
  return {
    role: presetKey,
    label: typeof m.name === "string" ? m.name : presetKey,
    activationGate: typeof m.activation_gate === "string" ? m.activation_gate : null,
    metrics,
    exitConditions,
    reviewCadence: typeof m.review_cadence === "string" ? m.review_cadence : "weekly",
  };
}

export function loadP2RolesFromAgents(rows: Array<{ preset_key: string; meta: unknown }>): P2RoleDef[] {
  return rows.flatMap((row) => {
    const def = parseP2RoleFromMeta(row.preset_key, row.meta);
    return def ? [def] : [];
  });
}

/** 指标是否低于目标（gte：值 < 目标；lte：值 > 目标）。 */
export function belowTarget(def: P2MetricDef, value: number): boolean {
  return def.direction === "gte" ? value < def.target : value > def.target;
}

/**
 * 周度评估：
 *  - 全指标缺数 → no_data；
 *  - 命中退场条件（最近连续低于目标周数 ≥ 声明值）→ exit_proposal；
 *  - 任一指标连续 2 周低于目标 → watch；
 *  - 否则 keep。
 */
export function evaluateP2Role(def: P2RoleDef, weeks: P2Week[]): P2Evaluation {
  const ordered = [...weeks].sort((a, b) => a.week.localeCompare(b.week));
  const missingMetrics = def.metrics
    .filter((m) => !ordered.some((w) => num(w.values[m.key]) !== null))
    .map((m) => m.key);
  if (missingMetrics.length === def.metrics.length) {
    return {
      role: def.role, label: def.label, status: "no_data",
      reasons: [`未取数：${missingMetrics.join("、")}；本周报不判定达标/退场`],
      missingMetrics,
    };
  }
  const reasons: string[] = [];
  let exit = false;
  let watch = false;
  for (const metric of def.metrics) {
    let streak = 0;
    for (let i = ordered.length - 1; i >= 0; i -= 1) {
      const value = num(ordered[i]!.values[metric.key]);
      if (value === null) break; // 缺数周中断连续计数
      if (!belowTarget(metric, value)) break;
      streak += 1;
    }
    const exitCond = def.exitConditions.find((c) => c.metric === metric.key);
    if (exitCond && streak >= exitCond.consecutiveBelow) {
      exit = true;
      reasons.push(`${metric.label} 连续 ${streak} 周低于目标 ${metric.target} → ${exitCond.action}`);
    } else if (streak >= 2) {
      watch = true;
      reasons.push(`${metric.label} 连续 ${streak} 周低于目标 ${metric.target}，进入观察`);
    }
  }
  if (exit) return { role: def.role, label: def.label, status: "exit_proposal", reasons, missingMetrics };
  if (watch) return { role: def.role, label: def.label, status: "watch", reasons, missingMetrics };
  return {
    role: def.role, label: def.label, status: "keep",
    reasons: ["各运营指标在窗口内达标"],
    missingMetrics,
  };
}
