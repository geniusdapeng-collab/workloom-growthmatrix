import { describe, expect, it } from "vitest";
import {
  TRIGGER_DECLARATION_VERSION,
  isValidCronExpression,
  mergeTriggerDeclarations,
  parseTriggerDeclarations,
  triggerGapReport,
} from "./triggers.js";

const file = (triggers: unknown[]) => ({ version: TRIGGER_DECLARATION_VERSION, triggers });

describe("声明式触发器", () => {
  it("cron 语法支持 5 字段的星号/列表/区间/步进/单值", () => {
    for (const expression of ["0 7 * * *", "*/30 * * * *", "0 9 * * 1", "7 */2 * * *", "0 9,18 * * 1-5"]) {
      expect(isValidCronExpression(expression), expression).toBe(true);
    }
    for (const expression of ["0 7 * *", "61 7 * * *", "* * * * * *", "abc"]) {
      expect(isValidCronExpression(expression), expression).toBe(false);
    }
  });

  it("解析拒绝重复 id、非法 cron 与空动作", () => {
    const good = parseTriggerDeclarations(JSON.stringify(file([
      { id: "tg-intel-0700", name: "情报刷新", schedule: "0 7 * * *", action: { dispatch: "geo-researcher", template: "intel.collect" } },
    ])), "good");
    expect(good.triggers).toHaveLength(1);

    const duplicate = file([
      { id: "tg-a", name: "A", schedule: "0 7 * * *", action: { dispatch: "geo-researcher" } },
      { id: "tg-a", name: "A2", schedule: "0 8 * * *", action: { dispatch: "geo-researcher" } },
    ]);
    expect(() => parseTriggerDeclarations(JSON.stringify(duplicate), "dup")).toThrow(/重复/);

    const badCron = file([{ id: "tg-b", name: "B", schedule: "0 25 * * *", action: { beat: "daily" } }]);
    expect(() => parseTriggerDeclarations(JSON.stringify(badCron), "cron")).toThrow(/cron/);

    const emptyAction = file([{ id: "tg-c", name: "C", schedule: "0 7 * * *", action: {} }]);
    expect(() => parseTriggerDeclarations(JSON.stringify(emptyAction), "action")).toThrow();
  });

  it("跨包合并主包优先，被遮蔽声明留痕", () => {
    const dependency = parseTriggerDeclarations(JSON.stringify(file([
      { id: "tg-metrics-2h", name: "依赖包指标采集", schedule: "7 */2 * * *", action: { dispatch: "data-board-officer" } },
      { id: "tg-hotel-lead", name: "线索巡检", schedule: "*/30 * * * *", action: { dispatch: "ai-receptionist" } },
    ])), "dep");
    const primary = parseTriggerDeclarations(JSON.stringify(file([
      { id: "tg-metrics-2h", name: "主包指标采集", schedule: "0 */2 * * *", action: { dispatch: "data-board-officer" } },
    ])), "primary");
    const merged = mergeTriggerDeclarations([
      { bundleId: "hotel", file: dependency },
      { bundleId: "geo-growth", file: primary },
    ]);
    const metrics = merged.find((item) => item.declaration.id === "tg-metrics-2h")!;
    expect(metrics.sourceBundleId).toBe("geo-growth");
    expect(metrics.declaration.name).toBe("主包指标采集");
    expect(metrics.shadowedBundleIds).toEqual(["hotel"]);
    expect(merged.map((item) => item.declaration.id)).toEqual(["tg-hotel-lead", "tg-metrics-2h"]);
  });

  it("对账报告列出未在编岗位与未知节拍", () => {
    const parsed = parseTriggerDeclarations(JSON.stringify(file([
      { id: "tg-a", name: "A", schedule: "0 7 * * *", action: { dispatch: "ghost-role" } },
      { id: "tg-b", name: "B", schedule: "30 8 * * *", action: { beat: "unknown-beat" } },
    ])), "gap");
    const composed = mergeTriggerDeclarations([{ bundleId: "geo-growth", file: parsed }]);
    const gaps = triggerGapReport(composed, { presetKeys: ["company-ceo"], beats: ["daily"] });
    expect(gaps.map((gap) => gap.triggerId).sort()).toEqual(["tg-a", "tg-b"]);
  });

  it("组合日历按模板与节拍去重：同一件事只保留主包权威声明", () => {
    const geo = parseTriggerDeclarations(JSON.stringify(file([
      { id: "tg-geo-metrics-2h", name: "主包指标采集", schedule: "7 */2 * * *", action: { dispatch: "data-board-officer", template: "metrics.collect" } },
      { id: "tg-geo-comments-30m", name: "主包评论分流", schedule: "*/30 * * * *", action: { dispatch: "private-domain-operator", template: "comments.ingest" } },
      { id: "tg-geo-ceo-brief-0830", name: "主包晨报", schedule: "30 8 * * *", action: { beat: "daily" } },
    ])), "geo");
    const aiVideo = parseTriggerDeclarations(JSON.stringify(file([
      { id: "tg-metrics-2h", name: "视频包指标采集", schedule: "7 */2 * * *", action: { dispatch: "metrics-watcher", template: "metrics.collect" } },
      { id: "tg-comments-30m", name: "视频包评论分流", schedule: "*/30 * * * *", action: { dispatch: "comment-operator", template: "comments.ingest" } },
      { id: "tg-morning-0800", name: "视频包早报", schedule: "0 8 * * *", action: { dispatch: "metrics-watcher", template: "report.morning" } },
      { id: "tg-ceo-brief-0830", name: "视频包晨报", schedule: "30 8 * * *", action: { beat: "daily" } },
    ])), "video");
    const merged = mergeTriggerDeclarations([
      { bundleId: "ai-video", file: aiVideo },
      { bundleId: "geo-growth", file: geo },
    ]);
    expect(merged.map((item) => item.declaration.id).sort()).toEqual([
      "tg-geo-ceo-brief-0830",
      "tg-geo-comments-30m",
      "tg-geo-metrics-2h",
      "tg-morning-0800",
    ]);
    const metrics = merged.find((item) => item.declaration.id === "tg-geo-metrics-2h")!;
    expect(metrics.shadowedBundleIds).toEqual(["ai-video"]);
  });
});
