/**
 * publish-rpa/readiness —— 通道就绪矩阵（B-75）
 *
 * 六视频平台 + 五图文通道的就绪状态单一事实源：
 *  - rpa：骨架/选择器已实现，需真实账号环境联调标定（登录态由用户在桌面包完成）；
 *  - placeholder：接口占位，联调前 fail-closed（tiktok/shipinhao 需桥或会话目录配置）；
 *  - declared_exclusion：本机无真实账号环境/凭据，按计划转「声明排除」，不得当作已联调。
 * 环境变量（桥优先，其次桌面会话目录）：
 *   WORKLOOM_TIKTOK_BRIDGE_URL/TOKEN、WORKLOOM_TIKTOK_SESSION_DIR
 *   WORKLOOM_SHIPINHAO_BRIDGE_URL/TOKEN、WORKLOOM_SHIPINHAO_SESSION_DIR
 */

export type ChannelReadinessState = "ready" | "needs_live_session" | "declared_exclusion";

export interface ChannelReadinessRow {
  id: string;
  label: string;
  kind: "video" | "text";
  state: ChannelReadinessState;
  detail: string;
}

interface ChannelDef {
  id: string;
  label: string;
  kind: "video" | "text";
  /** 桥 URL/Token 环境键；齐备 = ready */
  bridge?: [string, string];
  /** 桌面会话目录键；存在配置 = needs_live_session（仍需联调标定） */
  sessionKey?: string;
}

const CHANNELS: ChannelDef[] = [
  { id: "douyin", label: "抖音", kind: "video" },
  { id: "xiaohongshu", label: "小红书", kind: "video" },
  { id: "bilibili", label: "B 站", kind: "video" },
  { id: "youtube", label: "YouTube", kind: "video" },
  { id: "wechat-mp", label: "微信公众号", kind: "text" },
  { id: "weibo", label: "微博", kind: "text" },
  { id: "zhihu", label: "知乎", kind: "text" },
  { id: "toutiao", label: "头条号", kind: "text" },
  { id: "baijia", label: "百家号", kind: "text" },
  {
    id: "tiktok", label: "TikTok（海外）", kind: "video",
    bridge: ["WORKLOOM_TIKTOK_BRIDGE_URL", "WORKLOOM_TIKTOK_BRIDGE_TOKEN"],
    sessionKey: "WORKLOOM_TIKTOK_SESSION_DIR",
  },
  {
    id: "shipinhao", label: "微信视频号", kind: "video",
    bridge: ["WORKLOOM_SHIPINHAO_BRIDGE_URL", "WORKLOOM_SHIPINHAO_BRIDGE_TOKEN"],
    sessionKey: "WORKLOOM_SHIPINHAO_SESSION_DIR",
  },
];

export function channelReadiness(env: Record<string, string | undefined> = process.env): ChannelReadinessRow[] {
  return CHANNELS.map((channel) => {
    if (channel.bridge) {
      const [urlKey, tokenKey] = channel.bridge;
      const hasBridge = Boolean(env[urlKey]?.trim() && env[tokenKey]?.trim());
      if (hasBridge) {
        return { id: channel.id, label: channel.label, kind: channel.kind, state: "ready", detail: "桥已配置（登录态在工位侧）" };
      }
      const session = channel.sessionKey ? env[channel.sessionKey]?.trim() : "";
      if (session) {
        return {
          id: channel.id, label: channel.label, kind: channel.kind, state: "needs_live_session",
          detail: `会话目录已配置（${channel.sessionKey}），仍需真实账号联调标定选择器并回填回执样本`,
        };
      }
      return {
        id: channel.id, label: channel.label, kind: channel.kind, state: "declared_exclusion",
        detail: `未配置桥/会话目录（${channel.bridge.join("、")} / ${channel.sessionKey}）：按计划声明排除，不计入已联调`,
      };
    }
    return {
      id: channel.id, label: channel.label, kind: channel.kind, state: "needs_live_session",
      detail: "适配器骨架就绪；首次真机发布需在桌面包完成登录并标定选择器",
    };
  });
}

export function declaredExclusions(env: Record<string, string | undefined> = process.env): ChannelReadinessRow[] {
  return channelReadiness(env).filter((row) => row.state === "declared_exclusion");
}
