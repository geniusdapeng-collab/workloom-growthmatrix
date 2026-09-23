/**
 * review-console · 业务关卡批量放行（B-70，去审批化后的口径）
 *
 * 背景（决策 L-09）：基座「审批中心」已下线，治理落在**业务关卡**上——客户不是在"审批 AI"，
 * 而是在放行自己业务链路里的关卡（视频管线 G1–G10、定价确认、投放加投……）。因此减负的做法
 * 不是"批量批准"，而是：**低风险关卡批量放行 + 抽样复核 + 高风险逐条**，并给出 H1 负载仪表。
 *
 * 三条硬纪律（本模块只做纯规划，执行在 service 层）：
 *  ① L4（董事长级）与 high_risk 关卡**永不批量**——必须逐条看（人审责任的最后一道）；
 *  ② 批量放行受每日配额约束（默认 7 件/日，H1 口径）；超出部分进 hold，不静默丢弃；
 *  ③ 抽检必须可复现：同 seed 同候选集 → 同抽检名单（审计可复算），抽中项不进批量放行。
 */

export interface ReleaseCandidate {
  approvalId: string;
  tier: string;
  ageHours: number;
  highRisk: boolean;
  title?: string;
}

export interface BatchReleasePlan {
  /** 可直接批量放行（低风险 + 配额内 + 未被抽检） */
  autoRelease: ReleaseCandidate[];
  /** 被抽检：需人工看一眼再决定（不进批量） */
  sampled: ReleaseCandidate[];
  /** 留待人工逐条（L4 / 高危 / 超配额） */
  hold: ReleaseCandidate[];
  quota: number;
  todayReleased: number;
  remainingQuota: number;
  sampleRate: number;
  seed: number;
  /** 人读理由（H1 仪表与审计共用） */
  rationale: string[];
}

export const GATE_DAILY_QUOTA = 7;
export const GATE_SAMPLE_RATE = 0.2;

/** 确定性 PRNG（mulberry32）：同 seed 同序列，审计可复算 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const rand = mulberry32(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * 规划一批关卡的放行方式。
 * @param todayReleased 今日已放行数（H1 配额按"当日累计"计，防止分批绕过配额）
 */
export function planBatchRelease(
  candidates: readonly ReleaseCandidate[],
  opts: { quota?: number; sampleRate?: number; seed?: number; todayReleased?: number } = {},
): BatchReleasePlan {
  const quota = Number.isInteger(opts.quota) && (opts.quota as number) > 0 ? (opts.quota as number) : GATE_DAILY_QUOTA;
  const sampleRate = clamp(opts.sampleRate ?? GATE_SAMPLE_RATE, 0, 1);
  const seed = opts.seed ?? 20260924;
  const todayReleased = Math.max(0, opts.todayReleased ?? 0);
  const remainingQuota = Math.max(0, quota - todayReleased);

  const rationale: string[] = [];
  const hold: ReleaseCandidate[] = [];
  const batchable: ReleaseCandidate[] = [];
  for (const c of candidates) {
    if (c.tier === "l4_chairman") { hold.push(c); continue; }
    if (c.highRisk) { hold.push(c); continue; }
    batchable.push(c);
  }
  if (hold.length > 0) {
    rationale.push(`${hold.length} 件留待逐条（L4/高危不可批量放行）`);
  }

  // 抽检：批内按比例抽（按年龄降序稳定排序后做 seed 洗牌，保证同输入同结果）
  const ordered = [...batchable].sort((a, b) => b.ageHours - a.ageHours || a.approvalId.localeCompare(b.approvalId));
  const sampleCount = Math.min(ordered.length, Math.ceil(ordered.length * sampleRate));
  const sampled = seededShuffle(ordered, seed).slice(0, sampleCount);
  const sampledIds = new Set(sampled.map((c) => c.approvalId));
  const clean = ordered.filter((c) => !sampledIds.has(c.approvalId));

  const autoRelease = clean.slice(0, remainingQuota);
  const overQuota = clean.slice(remainingQuota);
  hold.push(...overQuota);

  rationale.push(`批量放行 ${autoRelease.length} 件（配额 ${quota}/日，今日已放行 ${todayReleased}，余 ${remainingQuota}）`);
  if (sampled.length > 0) rationale.push(`抽检 ${sampled.length} 件（抽检率 ${(sampleRate * 100).toFixed(0)}%，seed=${seed} 可复算）`);
  if (overQuota.length > 0) rationale.push(`超配额 ${overQuota.length} 件转入逐条（不静默丢弃）`);

  return {
    autoRelease, sampled, hold, quota, todayReleased, remainingQuota,
    sampleRate, seed, rationale,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** H1 负载仪表（纯函数）：把 7 日裁决时长与排队量压成一句可读结论 + 是否越线 */
export interface GateLoadInput {
  pending: number;
  pendingByTier: Record<string, number>;
  decidedToday: number;
  avgDecisionSeconds: number | null;
  overdue24h: number;
}

export interface GateLoadVerdict {
  level: "ok" | "watch" | "over";
  summary: string;
}

export function evaluateGateLoad(input: GateLoadInput, target = { perDay: GATE_DAILY_QUOTA, seconds: 30 }): GateLoadVerdict {
  const overQuota = input.decidedToday > target.perDay;
  const slow = input.avgDecisionSeconds !== null && input.avgDecisionSeconds > target.seconds;
  const backlog = input.overdue24h > 0;
  const level: GateLoadVerdict["level"] = overQuota || backlog ? "over" : slow ? "watch" : "ok";
  const parts = [
    `今日已裁决 ${input.decidedToday} 件（目标 ≤${target.perDay} 件/日）`,
    input.avgDecisionSeconds === null ? "均时长无样本" : `均时长 ${input.avgDecisionSeconds.toFixed(1)} 秒（目标 ≤${target.seconds} 秒）`,
    `排队 ${input.pending} 件（超 24h ${input.overdue24h} 件）`,
    `分层：${Object.entries(input.pendingByTier).map(([k, v]) => `${k} ${v}`).join(" · ") || "无"}`,
  ];
  return { level, summary: `${level === "ok" ? "负载正常" : level === "watch" ? "偏慢，建议合并处理" : "越线，请优先清关"}：${parts.join("；")}` };
}
