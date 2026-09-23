/**
 * B-64 首登行动卡 · 纯函数用例：三件事上限、L4 优先、空事实不出卡、来源可溯。
 */
import { describe, expect, it } from "vitest";
import { buildActionCard, type ActionCardFacts } from "./action-card.js";

const facts = (over: Partial<ActionCardFacts> = {}): ActionCardFacts => ({
  questline: { journeyName: "首日上岗", stageTitle: "第 2 关 · 今天最想解决的一件事", stageIndex: 1, totalStages: 4, completed: false },
  pendingGates: [],
  threads: { running: 0, pendingReview: 0 },
  briefing: null,
  ...over,
});

describe("B-64 首登行动卡", () => {
  it("空事实 → 不出卡（宁可不打卡，也不编任务）", () => {
    const card = buildActionCard(facts({ questline: null }), { now: new Date("2026-09-24T02:00:00Z") });
    expect(card.items).toEqual([]);
    expect(card.version).toBe("action-card/v1");
    expect(card.generatedAt).toBe("2026-09-24T02:00:00.000Z");
  });

  it("上限三件 + 优先级：待放行关卡 → 续播 → 待验收交付", () => {
    const card = buildActionCard(facts({
      pendingGates: [
        { approvalId: "APR-2", title: "投放加投 200 元", tier: "l3_fleet", ageHours: 30 },
        { approvalId: "APR-1", title: "品牌表态用词", tier: "l4_chairman", ageHours: 6 },
      ],
      threads: { running: 2, pendingReview: 3 },
      briefing: { eventId: "E-1", text: "晨报" },
    }));
    expect(card.items).toHaveLength(3);
    expect(card.items.map((i) => i.id)).toEqual(["gate-first", "questline-resume", "threads-verify"]);
    // L4 优先于 L3（即使更晚创建）
    expect(card.pendingGates[0]!.approvalId).toBe("APR-1");
    expect(card.items[0]!.title).toContain("2 件待办");
    expect(card.items[0]!.why).toContain("董事长级关卡");
    // 每件都有事实出处与去处
    for (const item of card.items) {
      expect(item.source.length).toBeGreaterThan(0);
      expect(item.to.startsWith("/")).toBe(true);
    }
  });

  it("首日上岗已完成 → 不再出现续播项；待验收为空但线程在跑 → 跟进项；无事实则不占位", () => {
    const done = buildActionCard(facts({
      questline: { journeyName: "首日上岗", stageTitle: "第 4 关 · 看看今天赚了什么", stageIndex: 4, totalStages: 4, completed: true },
      threads: { running: 2, pendingReview: 0 },
    }));
    expect(done.items.map((i) => i.id)).toEqual(["threads-running"]);
    const briefingOnly = buildActionCard(facts({ questline: null, briefing: { eventId: "E-9", text: "晨报" } }));
    expect(briefingOnly.items.map((i) => i.id)).toEqual(["briefing-read"]);
    expect(briefingOnly.items[0]!.source).toContain("E-9");
  });

  it("年龄展示不编数：0 小时按 0 显示，长等待给出小时数", () => {
    const card = buildActionCard(facts({
      questline: null,
      pendingGates: [{ approvalId: "APR-9", title: "定价确认", tier: "l2_captain", ageHours: 0 }],
    }));
    expect(card.items[0]!.why).toContain("已等 0 小时");
    expect(card.pendingGates).toHaveLength(1);
  });
});
