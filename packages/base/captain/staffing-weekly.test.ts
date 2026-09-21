/**
 * B-50 编制周报测试：扩编触发（SCALE-08）+ P2 条件岗指标/退场（SCALE-07）。
 */
import { describe, expect, it } from "vitest";
import { composeStaffingWeekly, isoWeekKey } from "./board.js";

describe("B-50 编制周报", () => {
  it("无缺口/积压/过载且 P2 健康 → 无需裁决", () => {
    const r = composeStaffingWeekly({
      period: "2026-W38",
      health: { agentCount: 74, backlog: 0, uncovered: [], overworked: [] },
      proposal: null,
      p2: [{ role: "lifecycle-growth-officer", label: "生命周期增长官", status: "keep", reasons: ["各运营指标在窗口内达标"], missingMetrics: [] }],
    });
    expect(r.needsChairman).toBe(false);
    expect(r.text).toContain("一、编制与负载：在岗 74 人");
    expect(r.text).toContain("三期".slice(0, 0) + "三、P2 条件岗");
    expect(r.text).toContain("lifecycle-growth-officer");
    expect(r.text).toContain("无需裁决");
  });

  it("覆盖缺口/积压/过载 → 扩编提案进周报并需裁决", () => {
    const r = composeStaffingWeekly({
      period: "2026-W38",
      health: { agentCount: 74, backlog: 12, uncovered: ["竞对侦察"], overworked: [] },
      proposal: {
        reason: "业务域「竞对侦察」近 7 天有经营活动但无专职数字员工（岗位覆盖缺口）",
        role: "竞对侦察",
        jd: { duty: "负责竞对侦察域全流程运营", skills: ["竞对侦察"], expected: "该域事件有人承接" },
      },
      p2: [],
    });
    expect(r.needsChairman).toBe(true);
    expect(r.text).toContain("二、扩编提案");
    expect(r.text).toContain("覆盖缺口");
    expect(r.text).toContain("请董事长裁决");
  });

  it("P2 退场提案 → 需董事长裁决；未取数如实标注", () => {
    const r = composeStaffingWeekly({
      period: "2026-W38",
      health: { agentCount: 74, backlog: 0, uncovered: [], overworked: [] },
      proposal: null,
      p2: [
        { role: "growth-partnership-officer", label: "渠道增长官", status: "exit_proposal", reasons: ["合作 ROI 连续 4 周低于目标 1.5 → 退场提案"], missingMetrics: [] },
        { role: "lifecycle-growth-officer", label: "生命周期增长官", status: "no_data", reasons: ["未取数"], missingMetrics: ["repurchase_rate"] },
      ],
    });
    expect(r.needsChairman).toBe(true);
    expect(r.text).toContain("退场提案");
    expect(r.text).toContain("未取数");
  });

  it("ISO 周键格式稳定且同输入同输出", () => {
    const d = new Date("2026-09-21T00:00:00Z");
    const key = isoWeekKey(d);
    expect(key).toMatch(/^\d{4}-W\d{2}$/);
    expect(isoWeekKey(new Date(d))).toBe(key);
  });
});
