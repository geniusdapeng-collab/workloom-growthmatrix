/**
 * publish-rpa · 百家号适配器（B-18 五类国内通道之一）
 * 分级：placeholder——需真实账号环境联调（含百度账号风控）。
 */
import type {
  ArticleAdapter, ArticleProfile, ArticleUploadInput, BrowserDriver, UploadResult,
} from "./base.js";
import type { PublishReceipt } from "../types.js";

export const BAIJIA_PROFILE: ArticleProfile = {
  platform: "baijia",
  uploadUrl: "https://baijiahao.baidu.com/builder/rc/edit?type=news",
  selectors: {
    loginIndicator: "[class*='user-name']",
    titleInput: "textarea[placeholder*='标题']",
    bodyInput: "div[contenteditable='true']",
    imageInput: "input[type='file'][accept*='image']",
    publishButton: "button:has-text('发布')",
    successToast: "div:has-text('发布成功')",
  },
  captionSpec: { captionMaxChars: 40, maxTags: 5, scheduleMinAheadMinutes: 0 },
  humanPace: { typeDelayMs: 80, pageWaitMs: 2_500, postUploadWaitMs: 6_000 },
  tier: "placeholder",
};

export function createBaijiaAdapter(): ArticleAdapter {
  return {
    profile: BAIJIA_PROFILE,
    loginCheck: () => Promise.resolve(false),
    upload: (_driver: BrowserDriver, _input: ArticleUploadInput): Promise<UploadResult> =>
      Promise.reject(new Error("百家号通道为占位（tier=placeholder）：需真实账号环境联调后启用")),
    receiptProbe: (_driver: BrowserDriver, ctx: { taskId: string; upload: UploadResult }): Promise<PublishReceipt> =>
      Promise.resolve({ taskId: ctx.taskId, platform: "baijia", synced: false }),
  };
}
