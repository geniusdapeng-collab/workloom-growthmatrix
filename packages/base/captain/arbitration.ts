/**
 * base/captain · 多 Agent 冲突仲裁 v0（S7）
 *
 * 适用：预算再分配、排期/资源、归因归属三类冲突（多 Agent 对同一资源给出不同方案）。
 * 规则（按序执行，硬边界优先）：
 *   ① 硬边界：涉钱 / 对外承诺 / 超自治带 → escalate（L4），不得自动裁决；
 *   ② 证据强度：confirmed > reported > inferred，最高者胜（grant）；
 *   ③ 同强度：归因贡献差 ≥10% 才可判（高者胜）；差值不足视为不可仲裁；
 *   ④ 仍不能决 → escalate，附双语备忘录（两个方案 + 明确建议）。
 * 说明：本函数只做裁决建议与留痕文本；执行仍走既有治理链（含围栏与审批）。
 */

export type ConflictType = "budget" | "schedule" | "attribution";
export type EvidenceStrength = "confirmed" | "reported" | "inferred";

export interface ConflictParty {
  agent: string;
  proposal: string;
  evidence: EvidenceStrength;
  /** 归因贡献（0–1，可缺省；仅用于同强度时的比较） */
  contribution?: number;
}

export interface Conflict {
  type: ConflictType;
  domain: string;
  summary: string;
  parties: ConflictParty[];
  involvesMoney?: boolean;
  involvesCommitment?: boolean;
  overBand?: boolean;
}

export interface ArbitrationOutcome {
  verdict: "grant" | "escalate";
  winner?: string;
  rationale: string;
  memo: string;
}

const EVIDENCE_RANK: Record<EvidenceStrength, number> = { confirmed: 3, reported: 2, inferred: 1 };
const CONTRIBUTION_GAP = 0.1;

export function arbitrate(conflict: Conflict): ArbitrationOutcome {
  if (conflict.parties.length < 2) {
    throw new Error("冲突仲裁至少需要两方提案");
  }
  if (conflict.involvesMoney || conflict.involvesCommitment || conflict.overBand) {
    const reason = conflict.overBand ? "超自治带" : conflict.involvesMoney ? "涉钱" : "涉对外承诺";
    return {
      verdict: "escalate",
      rationale: `硬边界（${reason}）：一律升级 L4 人审，AI 不自动裁决`,
      memo: arbitrationMemo(conflict, "按硬边界升级董事长裁决"),
    };
  }
  const ranked = [...conflict.parties].sort((a, b) => EVIDENCE_RANK[b.evidence] - EVIDENCE_RANK[a.evidence]);
  const top = ranked[0]!;
  const second = ranked[1]!;
  if (EVIDENCE_RANK[top.evidence] > EVIDENCE_RANK[second.evidence]) {
    return {
      verdict: "grant",
      winner: top.agent,
      rationale: `证据强度胜出：${top.agent}（${top.evidence}）> ${second.agent}（${second.evidence}）`,
      memo: arbitrationMemo(conflict, `采纳 ${top.agent} 方案（证据强度优先）`),
    };
  }
  const cTop = top.contribution ?? 0;
  const cSecond = second.contribution ?? 0;
  if (Math.abs(cTop - cSecond) >= CONTRIBUTION_GAP) {
    const winner = cTop > cSecond ? top : second;
    const loser = cTop > cSecond ? second : top;
    return {
      verdict: "grant",
      winner: winner.agent,
      rationale: `同证据强度，归因贡献差 ≥${CONTRIBUTION_GAP}：${winner.agent}（${Math.round(Math.max(cTop, cSecond) * 100)}%）> ${loser.agent}（${Math.round(Math.min(cTop, cSecond) * 100)}%）`,
      memo: arbitrationMemo(conflict, `采纳 ${winner.agent} 方案（归因贡献优先）`),
    };
  }
  return {
    verdict: "escalate",
    rationale: `证据强度同级且归因贡献差 <${CONTRIBUTION_GAP}：不可自动仲裁，升级 L4`,
    memo: arbitrationMemo(conflict, "不可仲裁：请在两方案间拍板"),
  };
}

/** 双语（中英）决策备忘录：两个方案 + 明确建议（升级场景使用）。 */
export function arbitrationMemo(conflict: Conflict, recommendation: string): string {
  const options = conflict.parties
    .map((p, i) => `方案 ${String.fromCharCode(65 + i)}（${p.agent}）：${p.proposal}〔证据：${p.evidence}${p.contribution !== undefined ? `，贡献 ${Math.round(p.contribution * 100)}%` : ""}〕`)
    .join("\n");
  return [
    `【冲突裁决备忘录 · ${conflict.domain} / ${conflict.type}】`,
    conflict.summary,
    options,
    `建议：${recommendation}`,
    "Situation / Options / Recommendation — WorkLoom Captain Arbitration v0",
  ].join("\n");
}

/* ================= B-39：冲突仲裁对象化（事件溯源对象 + 读模型） ================= */

/**
 * 对象化口径（与《规模化协作设计》§S7 同源）：
 *  - 冲突 从「一次性函数调用」升级为一等业务对象 `conflict_arbitration`（可查、可审计、可复算）；
 *  - 事件动作三件套：`conflict.raise`（登记冲突与两方提案）→ `conflict.arbitrate`（裁决：grant/escalate）
 *    → `conflict.resolve`（升级后的人审结论落账，含结论文本）；
 *  - 读模型由事件归约（`reduceConflict`），**不信任事件里声明的 status**：状态只能由合法动作推进，
 *    与契约状态机同一纪律（防伪造事件把冲突直接"跳"到 resolved）。
 */
export const CONFLICT_ACTIONS = ["raise", "arbitrate", "resolve"] as const;
export type ConflictAction = (typeof CONFLICT_ACTIONS)[number];

export const CONFLICT_STATUSES = ["raised", "granted", "escalated", "resolved"] as const;
export type ConflictStatus = (typeof CONFLICT_STATUSES)[number];

export const CONFLICT_VERDICTS = ["grant", "escalate"] as const;
export type ConflictVerdict = (typeof CONFLICT_VERDICTS)[number];

const TRANSITIONS: Record<ConflictAction, { from: readonly ConflictStatus[]; to: readonly ConflictStatus[] }> = {
  raise: { from: [], to: ["raised"] },
  arbitrate: { from: ["raised"], to: ["granted", "escalated"] },
  resolve: { from: ["escalated"], to: ["resolved"] },
};

export type ConflictAdvanceResult = { ok: true } | { ok: false; reason: string };

/** 校验一次冲突状态迁移（不抛异常，由调用方决定拒绝策略）。 */
export function advanceConflictStatus(current: ConflictStatus | null, action: ConflictAction): ConflictAdvanceResult {
  const t = TRANSITIONS[action];
  if (!t) return { ok: false, reason: `未知冲突动作 ${action}` };
  if (current === null) {
    return action === "raise" ? { ok: true } : { ok: false, reason: `冲突不存在，不允许动作 ${action}` };
  }
  if (!t.from.includes(current)) return { ok: false, reason: `状态 ${current} 不允许动作 ${action}` };
  return { ok: true };
}

export interface ConflictEventLike {
  action: string;
  after?: { verdict?: string | null; status?: string | null } | null;
}

/**
 * 由事件流归约冲突对象状态（事件溯源读模型）。
 * 只认 conflict.* 动作；无事件返回 null（冲突不存在）。声明值只在合法迁移内被采纳。
 */
export function reduceConflictStatus(events: readonly ConflictEventLike[]):
  { status: ConflictStatus; verdict: ConflictVerdict | null } | null {
  let status: ConflictStatus | null = null;
  let verdict: ConflictVerdict | null = null;
  for (const ev of events) {
    const action = ev.action.startsWith("conflict.") ? ev.action.slice("conflict.".length) : ev.action;
    if (!(CONFLICT_ACTIONS as readonly string[]).includes(action)) continue;
    const advance = advanceConflictStatus(status, action as ConflictAction);
    if (!advance.ok) continue;
    if (action === "raise") { status = "raised"; continue; }
    if (action === "arbitrate") {
      const declared = ev.after?.verdict;
      const picked: ConflictVerdict = declared === "grant" ? "grant" : declared === "escalate" ? "escalate" : "escalate";
      // 未声明或声明非法一律按保守方向（escalate）落档：宁可升级人审，不可静默自决
      status = picked === "grant" ? "granted" : "escalated";
      verdict = picked;
      continue;
    }
    status = "resolved";
  }
  return status === null ? null : { status, verdict };
}

/** 纯函数的对象化裁决：给定冲突登记信息与事件流，算当前状态、裁决结果与备忘录。 */
export function buildArbitrationRecord(
  conflict: Conflict,
  events: readonly ConflictEventLike[],
): { status: ConflictStatus | null; verdict: ConflictVerdict | null; outcome: ArbitrationOutcome } {
  const reduced = reduceConflictStatus(events);
  return { status: reduced?.status ?? null, verdict: reduced?.verdict ?? null, outcome: arbitrate(conflict) };
}
