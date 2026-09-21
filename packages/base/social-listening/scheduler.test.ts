import { describe, expect, it } from "vitest";
import { metricEntriesFromPosts, runCollectionTick, stalenessOf } from "./scheduler.js";

describe("B-54 采集调度接线", () => {
  it("内容指标映射为 account_metrics 条目（询盘→conversions 代理口径）", () => {
    const entries = metricEntriesFromPosts(
      [{ postId: "p1", title: "样例", plays: 1000, likes: 80, comments: 6, inquiries: 3 }],
      { platform: "douyin", accountId: "@acc", capturedAt: "2026-09-22T02:00:00Z" },
    );
    expect(entries[0]).toMatchObject({
      platform: "douyin", accountId: "@acc", videoId: "p1", plays: 1000, likes: 80, comments: 6, conversions: 3,
    });
  });

  it("陈旧判定：无数据/超 3 小时为 stale，1 小时为新鲜", () => {
    const now = new Date("2026-09-22T02:00:00Z");
    expect(stalenessOf(null, now)).toEqual({ stale: true, ageHours: null });
    expect(stalenessOf("2026-09-22T01:00:00Z", now).stale).toBe(false);
    expect(stalenessOf("2026-09-21T20:00:00Z", now)).toMatchObject({ stale: true, ageHours: 6 });
  });

  it("未配置连接器 → unconfigured（零写库、不回退 mock）", async () => {
    const result = await runCollectionTick({} as never, {} as never, { tenantId: "t", workspaceId: "w" }, {
      range: { from: "2026-09-01", to: "2026-09-22" },
      rules: [],
      accountId: "@acc",
      env: {} as NodeJS.ProcessEnv,
    });
    expect(result.status).toBe("unconfigured");
    expect(result.message).toContain("DOUYIN_OPEN_URL");
    expect(result.collected).toBe(0);
  });
});
