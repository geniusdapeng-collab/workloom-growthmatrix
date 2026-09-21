/**
 * 连接器就绪层 · 契约单测（fail-closed / 重试 / 超时 / 解析）。
 * 夹具即契约：与 docs/connectors-mock-exit.md 的"mock 退出标准"一一对应。
 */
import { describe, expect, it } from "vitest";
import {
  connectorReadiness, fetchCampaignMetrics, fetchDouyinLocalRedemptions, fetchOtaPrices, fetchOtaReviews,
  fetchPmsOrders, fetchPostComments, fetchPostMetrics, fetchWecomLeads,
} from "./index.js";
import { ConnectorRequestError, ConnectorUnconfiguredError } from "./types.js";

const ENV_OK = {
  ADS_GATEWAY_URL: "https://ads.example.test",
  ADS_GATEWAY_TOKEN: "tok",
  DOUYIN_OPEN_URL: "https://open.douyin.example.test",
  DOUYIN_ACCESS_TOKEN: "tok",
  DOUYIN_OPEN_ID: "open-1",
  PMS_URL: "https://pms.example.test", PMS_TOKEN: "tok",
  OTA_MONITOR_URL: "https://ota.example.test", OTA_MONITOR_TOKEN: "tok",
  WECOM_URL: "https://wecom.example.test", WECOM_TOKEN: "tok",
  DOUYIN_LOCAL_URL: "https://douyin-local.example.test", DOUYIN_LOCAL_TOKEN: "tok",
} as unknown as NodeJS.ProcessEnv;

const ENV_B32 = {
  PMS_URL: "https://pms.example.test", PMS_TOKEN: "tok",
  OTA_MONITOR_URL: "https://ota.example.test", OTA_MONITOR_TOKEN: "tok",
  WECOM_URL: "https://wecom.example.test", WECOM_TOKEN: "tok",
  DOUYIN_LOCAL_URL: "https://douyin-local.example.test", DOUYIN_LOCAL_TOKEN: "tok",
} as unknown as NodeJS.ProcessEnv;

describe("连接器就绪层", () => {
  it("缺凭证 fail-closed：抛 ConnectorUnconfiguredError，绝不回退 mock", async () => {
    await expect(fetchCampaignMetrics({ from: "2026-09-01", to: "2026-09-07" }, { env: {} as NodeJS.ProcessEnv }))
      .rejects.toBeInstanceOf(ConnectorUnconfiguredError);
  });

  it("就绪状态报告：未配置为 unconfigured（含缺失项），配置齐全为 ready", () => {
    const none = connectorReadiness({ env: {} as NodeJS.ProcessEnv });
    expect(none.every((h) => h.state === "unconfigured")).toBe(true);
    expect(none[0]!.detail).toContain("ADS_GATEWAY_URL");
    expect(connectorReadiness({ env: ENV_OK }).every((h) => h.state === "ready")).toBe(true);
  });

  it("成功路径：解析投放指标与内容指标（fixture 契约）", async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("/posts/metrics")) {
        return new Response(JSON.stringify({ posts: [{ postId: "p1", title: "样例", plays: 12_000, likes: 320, comments: 18, inquiries: 3 }] }));
      }
      return new Response(JSON.stringify({ metrics: [{ campaignId: "c1", spendFen: 100_000, impressions: 10_000, clicks: 300, conversions: 12, roi: 2.4 }] }));
    }) as unknown as typeof fetch;
    const ads = await fetchCampaignMetrics({ from: "2026-09-01", to: "2026-09-07" }, { env: ENV_OK, fetchImpl });
    expect(ads.metrics[0]).toMatchObject({ campaignId: "c1", roi: 2.4 });
    const posts = await fetchPostMetrics({ from: "2026-09-01", to: "2026-09-07" }, { env: ENV_OK, fetchImpl });
    expect(posts.posts[0]).toMatchObject({ postId: "p1", inquiries: 3 });
  });

  it("429 自动重试后成功（重试次数可留痕）", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) return new Response("rate limited", { status: 429 });
      return new Response(JSON.stringify({ comments: [{ commentId: "cm1", text: "怎么合作", createdAt: "2026-09-19" }] }));
    }) as unknown as typeof fetch;
    const r = await fetchPostComments("p1", { env: ENV_OK, fetchImpl, sleep: async () => {} });
    expect(r.comments[0]!.commentId).toBe("cm1");
    expect(r.attempts).toBe(2);
  });

  it("4xx 不重试：直接失败（避免把权限问题当网络抖动）", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("forbidden", { status: 403 });
    }) as unknown as typeof fetch;
    await expect(fetchCampaignMetrics({ from: "a", to: "b" }, { env: ENV_OK, fetchImpl })).rejects.toBeInstanceOf(ConnectorRequestError);
    expect(calls).toBe(1);
  });

  it("B-32 四类连接器纳入就绪报告：未配置逐项列出缺失键", () => {
    const health = connectorReadiness({ env: {} as NodeJS.ProcessEnv });
    const ids = health.map((h) => h.id);
    expect(ids).toEqual(expect.arrayContaining(["pms", "ota-monitor", "wecom", "douyin-local"]));
    expect(health.find((h) => h.id === "pms")!.detail).toContain("PMS_URL");
    expect(connectorReadiness({ env: ENV_B32 }).filter((h) => ["pms", "ota-monitor", "wecom", "douyin-local"].includes(h.id)).every((h) => h.state === "ready")).toBe(true);
  });

  it("B-32 取数：PMS 订单 / OTA 价格与评论 / 企微客资 / 抖音核销 解析正确", async () => {
    const fetchImpl = (async (url: string) => {
      const u = String(url);
      if (u.includes("/pms/orders")) return new Response(JSON.stringify({ orders: [{ orderId: "o1", roomTypeId: "rt1", checkIn: "2026-09-20", checkOut: "2026-09-21", status: "checked_in", amountFen: 88000 }] }));
      if (u.includes("/ota/prices")) return new Response(JSON.stringify({ prices: [{ platform: "ctrip", roomTypeId: "rt1", date: "2026-09-22", priceFen: 52000 }] }));
      if (u.includes("/ota/reviews")) return new Response(JSON.stringify({ reviews: [{ platform: "meituan", reviewId: "rv1", rating: 2, text: "隔音差", createdAt: "2026-09-21" }] }));
      if (u.includes("/wecom/leads")) return new Response(JSON.stringify({ leads: [{ leadId: "l1", contactMasked: "138****8000", intent: "预约", createdAt: "2026-09-22" }] }));
      return new Response(JSON.stringify({ redemptions: [{ redemptionId: "r1", couponId: "cpn1", verifiedAt: "2026-09-22T10:00:00+08:00", amountFen: 29900 }] }));
    }) as unknown as typeof fetch;
    const range = { from: "2026-09-01", to: "2026-09-30" };
    expect((await fetchPmsOrders(range, { env: ENV_B32, fetchImpl })).orders[0]).toMatchObject({ orderId: "o1", amountFen: 88000 });
    expect((await fetchOtaPrices(range, { env: ENV_B32, fetchImpl })).prices[0]).toMatchObject({ platform: "ctrip", priceFen: 52000 });
    expect((await fetchOtaReviews(range, { env: ENV_B32, fetchImpl })).reviews[0]).toMatchObject({ reviewId: "rv1", rating: 2 });
    expect((await fetchWecomLeads(range, { env: ENV_B32, fetchImpl })).leads[0]).toMatchObject({ leadId: "l1", contactMasked: "138****8000" });
    expect((await fetchDouyinLocalRedemptions(range, { env: ENV_B32, fetchImpl })).redemptions[0]).toMatchObject({ redemptionId: "r1", amountFen: 29900 });
  });

  it("B-32 未配置时 fail-closed（四类连接器一致）", async () => {
    const range = { from: "a", to: "b" };
    await expect(fetchPmsOrders(range, { env: {} as NodeJS.ProcessEnv })).rejects.toBeInstanceOf(ConnectorUnconfiguredError);
    await expect(fetchWecomLeads(range, { env: {} as NodeJS.ProcessEnv })).rejects.toBeInstanceOf(ConnectorUnconfiguredError);
  });
});
