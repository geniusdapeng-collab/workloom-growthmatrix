/**
 * publish-rpa · 知乎适配器（B-18 五类国内通道之一）
 * 分级：placeholder——创作中心编辑器与风控（验证码/设备指纹）需真实账号环境联调标定；
 *      联调完成前 loginCheck 恒 false、upload 直接拒绝（runner 转人工，不静默执行）。
 */
import type {
  ArticleAdapter, ArticleProfile, ArticleUploadInput, BrowserDriver, UploadResult,
} from "./base.js";
import type { PublishReceipt } from "../types.js";

export const ZHIHU_PROFILE: ArticleProfile = {
  platform: "zhihu",
  uploadUrl: "https://zhuanlan.zhihu.com/write",
  selectors: {
    loginIndicator: "[class*='AppHeader-profile']",
    titleInput: "textarea[placeholder*='标题']",
    bodyInput: "div[contenteditable='true']",
    imageInput: "input[type='file'][accept*='image']",
    publishButton: "button:has-text('发布')",
    successToast: "div:has-text('发布成功')",
  },
  captionSpec: { captionMaxChars: 100, maxTags: 5, scheduleMinAheadMinutes: 0 },
  humanPace: { typeDelayMs: 80, pageWaitMs: 2_500, postUploadWaitMs: 6_000 },
  tier: "placeholder",
};

export function createZhihuAdapter(): ArticleAdapter {
  return {
    profile: ZHIHU_PROFILE,
    loginCheck: () => Promise.resolve(false),
    upload: (_driver: BrowserDriver, _input: ArticleUploadInput): Promise<UploadResult> =>
      Promise.reject(new Error("知乎通道为占位（tier=placeholder）：需真实账号环境联调后启用")),
    receiptProbe: (_driver: BrowserDriver, ctx: { taskId: string; upload: UploadResult }): Promise<PublishReceipt> =>
      Promise.resolve({ taskId: ctx.taskId, platform: "zhihu", synced: false }),
  };
}
