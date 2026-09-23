/**
 * B-36 五模式执行器测试：编排形状、硬性人数约束、黑板单主写者、串行依赖。
 */
import { describe, expect, it } from "vitest";
import { blackboardWriteGuard, planDispatch, summarizeDispatch } from "./dispatch.js";

describe("B-36 五模式执行器", () => {
  it("m1 单人：恰好 1 名参与岗位，单泳道带回执", () => {
    const plan = planDispatch({ mode: "m1_single", goal: "写一条周报", participants: ["review-analyst"] });
    expect(plan.lanes).toHaveLength(1);
    expect(plan.rules.join("；")).toContain("无回执不算完成");
    expect(() => planDispatch({ mode: "m1_single", goal: "x", participants: ["a", "b"] })).toThrow(/最多允许 1/);
  });

  it("m2 管线：阶段串行依赖，缺交接回执不得开工", () => {
    const plan = planDispatch({
      mode: "m2_pipeline", goal: "日更一条图文",
      participants: ["content-agent", "visual-designer", "publish-operator"],
      stages: ["策划", "出图", "发布"],
      contractId: "CT-pipeline-001",
    });
    expect(plan.lanes.map((l) => l.id)).toEqual(["stage-1-策划", "stage-2-出图", "stage-3-发布"]);
    expect(plan.lanes[1]!.dependsOn).toEqual(["stage-1-策划"]);
    expect(plan.rules.join("；")).toContain("无交接回执");
    expect(() => planDispatch({ mode: "m2_pipeline", goal: "x", participants: ["a", "b"], stages: ["只一段"], contractId: "CT-x" })).toThrow(/阶段名/);
  });

  it("m3 黑板：首名参与者为唯一主写者，其他角色写入被拒", () => {
    const plan = planDispatch({
      mode: "m3_blackboard", goal: "融合三本账",
      participants: ["review-analyst", "data-board-officer"], boardTopic: "全网存在感",
      contractId: "CT-blackboard-001",
    });
    expect(plan.blackboardWriter).toBe("review-analyst");
    expect(blackboardWriteGuard(plan, "review-analyst").ok).toBe(true);
    const denied = blackboardWriteGuard(plan, "data-board-officer");
    expect(denied.ok).toBe(false);
    expect(denied.reason).toContain("单主写者");
  });

  it("m4 契约：三段状态机 + 无验收不结算；m5 战役：协调岗 + 并行工作流", () => {
    const contract = planDispatch({ mode: "m4_contract", goal: "交付海报", participants: ["requester", "assignee", "verifier"] });
    expect(contract.lanes.map((l) => l.kind)).toEqual(["coordinate", "work", "verify"]);
    expect(contract.rules.join("；")).toContain("无验收不得结算");
    const campaign = planDispatch({
      mode: "m5_campaign", goal: "双十一获客战役",
      participants: ["growth-lead", "content-agent", "ads-optimizer", "private-domain-operator"],
      stages: ["内容", "投放", "承接"],
      contractId: "CT-campaign-001",
    });
    expect(campaign.lanes[0]!.kind).toBe("coordinate");
    expect(campaign.lanes.filter((l) => l.kind === "work")).toHaveLength(3);
    expect(campaign.lanes.every((l, i) => i === 0 || l.dependsOn.includes("campaign-coordinate"))).toBe(true);
    expect(summarizeDispatch(campaign)).toContain("m5_campaign");
  });

  it("空目标/重复岗位/人数不足一律拒绝（不静默降级）", () => {
    expect(() => planDispatch({ mode: "m1_single", goal: "  ", participants: ["a"] })).toThrow(/目标/);
    expect(() => planDispatch({ mode: "m3_blackboard", goal: "x", participants: ["a", "a"], contractId: "CT-x" })).toThrow(/重复/);
    expect(() => planDispatch({ mode: "m4_contract", goal: "x", participants: ["a", "b"] })).toThrow(/至少 3/);
  });

  it("B-71 G-CON1：跨岗排产无契约一律拒绝（不静默降级）；单人/契约模式不受影响", () => {
    expect(() => planDispatch({
      mode: "m2_pipeline", goal: "日更图文", participants: ["content-agent", "publish-operator"], stages: ["出稿", "发布"],
    })).toThrow(/G-CON1|无契约不得排产/);
    expect(() => planDispatch({
      mode: "m3_blackboard", goal: "三本账", participants: ["review-analyst", "data-board-officer"],
    })).toThrow(/G-CON1/);
    expect(() => planDispatch({
      mode: "m5_campaign", goal: "战役", participants: ["lead", "a", "b"], stages: ["内容", "投放"],
    })).toThrow(/G-CON1/);
    // m1 单人闭环与 m4 契约协作（本次契约即排产依据）不需要既有契约
    expect(planDispatch({ mode: "m1_single", goal: "写周报", participants: ["review-analyst"] }).contractId).toBeNull();
    const contractPlan = planDispatch({ mode: "m4_contract", goal: "交付海报", participants: ["requester", "assignee", "verifier"] });
    expect(contractPlan.contractId).toBeNull();
    // 带契约的跨岗计划：契约 id 落到计划里（可审计"这次排产依据哪份契约"）
    const withContract = planDispatch({
      mode: "m2_pipeline", goal: "日更图文", participants: ["content-agent", "publish-operator"],
      stages: ["出稿", "发布"], contractId: " CT-abc ",
    });
    expect(withContract.contractId).toBe("CT-abc");
  });
});
