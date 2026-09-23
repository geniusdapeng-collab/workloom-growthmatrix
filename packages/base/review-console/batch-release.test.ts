/**
 * B-70 业务关卡批量放行 · 纯函数用例：
 *  ① L4 与高危永不批量（人审责任的最后一道）；
 *  ② 每日配额按"当日累计"计（分批不能绕过）；超出转 hold 不静默丢弃；
 *  ③ 抽检可复算（同 seed 同名单），抽中项不进批量；
 *  ④ H1 负载仪表口径（≤7 件/日、≤30 秒/件）。
 */
import { describe, expect, it } from "vitest";
import { evaluateGateLoad, planBatchRelease, GATE_DAILY_QUOTA, type ReleaseCandidate } from "./batch-release.js";

const gate = (id: string, over: Partial<ReleaseCandidate> = {}): ReleaseCandidate => ({
  approvalId: id, tier: "l2_captain", ageHours: 1, highRisk: false, ...over,
});

describe("B-70 业务关卡批量放行", () => {
  it("L4 与高危一律逐条：不进批量也不进抽检", () => {
    const plan = planBatchRelease([
      gate("APR-1"),
      gate("APR-2", { tier: "l4_chairman" }),
      gate("APR-3", { highRisk: true }),
      gate("APR-4", { tier: "l3_fleet" }),
    ], { quota: 7, sampleRate: 0, seed: 1 });
    expect(plan.autoRelease.map((c) => c.approvalId)).toEqual(["APR-1", "APR-4"]);
    expect(plan.hold.map((c) => c.approvalId).sort()).toEqual(["APR-2", "APR-3"]);
    expect(plan.sampled).toEqual([]);
    expect(plan.rationale.join("；")).toContain("留待逐条");
  });

  it("配额按当日累计：已放行 6 件 + 配额 7 → 本批最多再放 1 件，其余转 hold", () => {
    const candidates = ["A", "B", "C", "D"].map((id) => gate(`APR-${id}`, { ageHours: 5 }));
    const plan = planBatchRelease(candidates, { quota: 7, todayReleased: 6, sampleRate: 0, seed: 1 });
    expect(plan.remainingQuota).toBe(1);
    expect(plan.autoRelease).toHaveLength(1);
    expect(plan.hold).toHaveLength(3);
    expect(plan.rationale.join("；")).toContain("超配额 3 件转入逐条");
  });

  it("抽检可复算：同 seed 同名单；抽中项不进批量放行", () => {
    const candidates = Array.from({ length: 10 }, (_, i) => gate(`APR-${i + 1}`, { ageHours: 10 - i }));
    const a = planBatchRelease(candidates, { quota: 20, sampleRate: 0.3, seed: 42 });
    const b = planBatchRelease(candidates, { quota: 20, sampleRate: 0.3, seed: 42 });
    expect(a.sampled.map((c) => c.approvalId)).toEqual(b.sampled.map((c) => c.approvalId));
    expect(a.sampled).toHaveLength(3);
    const sampledIds = new Set(a.sampled.map((c) => c.approvalId));
    expect(a.autoRelease.some((c) => sampledIds.has(c.approvalId))).toBe(false);
    expect(a.autoRelease.length + a.sampled.length + a.hold.length).toBe(10); // 不丢候选
    const c = planBatchRelease(candidates, { quota: 20, sampleRate: 0.3, seed: 43 });
    expect(c.sampled.map((x) => x.approvalId)).not.toEqual(a.sampled.map((x) => x.approvalId));
  });

  it("H1 负载仪表：越线（超配额/超龄）→ over；仅偏慢 → watch；正常 → ok", () => {
    const base = { pending: 3, pendingByTier: { l4_chairman: 1, l2_captain: 2 }, decidedToday: 5, avgDecisionSeconds: 20, overdue24h: 0 };
    expect(evaluateGateLoad(base).level).toBe("ok");
    expect(evaluateGateLoad({ ...base, avgDecisionSeconds: 45 }).level).toBe("watch");
    expect(evaluateGateLoad({ ...base, decidedToday: GATE_DAILY_QUOTA + 1 }).level).toBe("over");
    expect(evaluateGateLoad({ ...base, overdue24h: 2 }).level).toBe("over");
    expect(evaluateGateLoad({ ...base, avgDecisionSeconds: null }).summary).toContain("无样本");
  });
});
