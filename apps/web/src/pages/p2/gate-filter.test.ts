/**
 * 业务关卡卡可见性回归（2026-09-24）
 * 事故：`publish_article`（LLM 自造动作名）关卡的卡被过滤 → 线程 pending_review 但人看不到、
 * 放不了行（真机 T-126 实测）。修复后判定以运行时 `snapshot.gate` 事实位为准。
 */
import { describe, expect, it } from "vitest";
import { isVisibleGateCard } from "./gate-filter";

describe("isVisibleGateCard", () => {
  it("运行时落了 gate: true → 无论动作名是否在白名单里都显示（修复点）", () => {
    expect(isVisibleGateCard({ gate: true, action: "publish_article" })).toBe(true);
    expect(isVisibleGateCard({ gate: true, action: "刚刚自造的动作名" })).toBe(true);
    expect(isVisibleGateCard({ gate: true })).toBe(true);
  });

  it("gate: false → 不显示（显式否定优先于命名兜底）", () => {
    expect(isVisibleGateCard({ gate: false, action: "publish.execute" })).toBe(false);
  });

  it("历史遗留行（无 gate 位）仍按命名兜底判定", () => {
    expect(isVisibleGateCard({ action: "publish.execute" })).toBe(true);
    expect(isVisibleGateCard({ action: "gate.confirm" })).toBe(true);
    expect(isVisibleGateCard({ action: "publish_article" })).toBe(false);
    expect(isVisibleGateCard({})).toBe(false);
    expect(isVisibleGateCard(null)).toBe(false);
  });
});
