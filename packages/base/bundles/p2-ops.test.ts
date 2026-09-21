/**
 * B-50 P2 条件岗运营指标与退场判定测试。
 */
import { describe, expect, it } from "vitest";
import { belowTarget, evaluateP2Role, loadP2RolesFromAgents, parseP2RoleFromMeta, type P2RoleDef } from "./p2-ops.js";

const def: P2RoleDef = {
  role: "lifecycle-growth-officer",
  label: "生命周期增长官",
  activationGate: "G-GROW7",
  metrics: [
    { key: "wakeup_conversion_rate", label: "唤醒转化率", target: 0.08, direction: "gte", windowWeeks: 4 },
    { key: "repurchase_rate", label: "复购率", target: 0.15, direction: "gte", windowWeeks: 4 },
  ],
  exitConditions: [{ metric: "wakeup_conversion_rate", consecutiveBelow: 4, action: "退场提案" }],
  reviewCadence: "weekly",
};

const weeks = (rows: Array<[string, number | null, number | null]>) =>
  rows.map(([week, wake, buy]) => ({
    week,
    values: {
      ...(wake === null ? {} : { wakeup_conversion_rate: wake }),
      ...(buy === null ? {} : { repurchase_rate: buy }),
    },
  }));

describe("B-50 P2 运营声明解析", () => {
  it("从 agents.meta 透传字段解析；非 P2 岗返回 null", () => {
    const parsed = parseP2RoleFromMeta("lifecycle-growth-officer", {
      name: "生命周期增长官",
      activation_gate: "G-GROW7",
      ops_metrics: [{ key: "wakeup_conversion_rate", label: "唤醒转化率", target: 0.08, direction: "gte", window_weeks: 4 }],
      exit_conditions: [{ metric: "wakeup_conversion_rate", consecutive_below: 4, action: "退场提案" }],
    });
    expect(parsed).toMatchObject({ role: "lifecycle-growth-officer", label: "生命周期增长官", activationGate: "G-GROW7" });
    expect(parsed!.metrics).toHaveLength(1);
    expect(parseP2RoleFromMeta("geo-researcher", { name: "调研员" })).toBeNull();
    expect(loadP2RolesFromAgents([
      { preset_key: "lifecycle-growth-officer", meta: { name: "生命周期增长官", ops_metrics: [{ key: "a", target: 1 }] } },
      { preset_key: "geo-researcher", meta: { name: "调研员" } },
    ])).toHaveLength(1);
  });
});

describe("B-50 周度评估（keep / watch / exit_proposal / no_data）", () => {
  it("全指标缺数 → no_data（不虚报达标）", () => {
    const r = evaluateP2Role(def, weeks([["2026-W36", null, null], ["2026-W37", null, null]]));
    expect(r.status).toBe("no_data");
    expect(r.missingMetrics.sort()).toEqual(["repurchase_rate", "wakeup_conversion_rate"]);
  });

  it("达标 → keep；连续 2 周低于目标 → watch", () => {
    expect(evaluateP2Role(def, weeks([["2026-W36", 0.1, 0.2], ["2026-W37", 0.11, 0.21]])).status).toBe("keep");
    const watching = evaluateP2Role(def, weeks([["2026-W36", 0.07, 0.2], ["2026-W37", 0.06, 0.2]]));
    expect(watching.status).toBe("watch");
    expect(watching.reasons.join("；")).toContain("唤醒转化率");
  });

  it("连续 4 周低于退场阈值 → exit_proposal；缺数周中断连续计数", () => {
    const exit = evaluateP2Role(def, weeks([
      ["2026-W34", 0.07, 0.2], ["2026-W35", 0.07, 0.2], ["2026-W36", 0.06, 0.2], ["2026-W37", 0.06, 0.2],
    ]));
    expect(exit.status).toBe("exit_proposal");
    expect(exit.reasons.join("；")).toContain("连续 4 周低于目标");
    const interrupted = evaluateP2Role(def, weeks([
      ["2026-W34", 0.07, 0.2], ["2026-W35", null, 0.2], ["2026-W36", 0.06, 0.2], ["2026-W37", 0.06, 0.2],
    ]));
    expect(interrupted.status).toBe("watch");
  });

  it("lte 方向：高于目标才算低于", () => {
    const m = { key: "cost", label: "成本", target: 10, direction: "lte" as const, windowWeeks: 4 };
    expect(belowTarget(m, 12)).toBe(true);
    expect(belowTarget(m, 8)).toBe(false);
  });
});
