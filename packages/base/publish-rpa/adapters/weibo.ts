/**
 * publish-rpa · 微博适配器（B-18 五类国内通道之一）
 * 分级：rpa（微博头条文章/长微博编辑器骨架；选择器需真实账号联调）
 */
import {
  probeArticleByProfile,
  uploadArticleByProfile,
  type ArticleAdapter,
  type ArticleProfile,
  type ArticleUploadInput,
  type BrowserDriver,
  type UploadResult,
} from "./base.js";
import type { PublishReceipt } from "../types.js";

export const WEIBO_PROFILE: ArticleProfile = {
  platform: "weibo",
  uploadUrl: "https://weibo.com/ttarticle/p/show?id=0",
  selectors: {
    loginIndicator: "[class*='Avatar']",
    titleInput: "input[placeholder*='标题']",
    bodyInput: "div[contenteditable='true']",
    imageInput: "input[type='file'][accept*='image']",
    tagInput: "input[placeholder*='话题']",
    publishButton: "button:has-text('发布')",
    successToast: "div:has-text('发布成功')",
  },
  captionSpec: { captionMaxChars: 30, maxTags: 5, scheduleMinAheadMinutes: 0 },
  humanPace: { typeDelayMs: 75, pageWaitMs: 2_000, postUploadWaitMs: 5_000 },
  tier: "rpa",
};

export function createWeiboAdapter(): ArticleAdapter {
  return {
    profile: WEIBO_PROFILE,
    loginCheck: (driver: BrowserDriver) =>
      driver.isLoggedIn(WEIBO_PROFILE.uploadUrl, WEIBO_PROFILE.selectors.loginIndicator),
    upload: (driver: BrowserDriver, input: ArticleUploadInput): Promise<UploadResult> =>
      uploadArticleByProfile(WEIBO_PROFILE, driver, input),
    receiptProbe: (driver: BrowserDriver, ctx: { taskId: string; upload: UploadResult }): Promise<PublishReceipt> =>
      probeArticleByProfile(WEIBO_PROFILE, driver, ctx),
  };
}
