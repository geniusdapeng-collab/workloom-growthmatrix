/**
 * B-75 通道就绪矩阵测试。
 */
import { describe, expect, it } from "vitest";
import { channelReadiness, declaredExclusions } from "./readiness.js";

describe("B-75 通道就绪矩阵", () => {
  it("六视频 + 五图文共 11 通道；未配置 TikTok/视频号 → 声明排除", () => {
    const rows = channelReadiness({});
    expect(rows).toHaveLength(11);
    const exclusions = declaredExclusions({});
    expect(exclusions.map((r) => r.id)).toEqual(["tiktok", "shipinhao"]);
    expect(exclusions[0]!.detail).toContain("声明排除");
  });

  it("配置桥 → ready；仅配置会话目录 → needs_live_session（不冒充足联调）", () => {
    const bridged = channelReadiness({
      WORKLOOM_TIKTOK_BRIDGE_URL: "https://bridge.example/tiktok",
      WORKLOOM_TIKTOK_BRIDGE_TOKEN: "t",
    });
    expect(bridged.find((r) => r.id === "tiktok")!.state).toBe("ready");
    const session = channelReadiness({ WORKLOOM_SHIPINHAO_SESSION_DIR: "/tmp/sph-session" });
    expect(session.find((r) => r.id === "shipinhao")!.state).toBe("needs_live_session");
  });

  it("国内通道骨架统一为 needs_live_session，不可被误标 ready", () => {
    const rows = channelReadiness({});
    for (const id of ["douyin", "xiaohongshu", "bilibili", "youtube", "wechat-mp", "weibo", "zhihu", "toutiao", "baijia"]) {
      expect(rows.find((r) => r.id === id)!.state).toBe("needs_live_session");
    }
  });
});
