/**
 * publish-rpa · 微信公众号适配器（B-18 五类国内通道之一）
 * 分级：rpa（创作平台图文编辑器骨架；选择器需按真实账号环境联调标定）
 * ⚠ 群发仍有平台侧确认环节：草稿/预览可自动，群发失败一律转人工（无回执=未核实）。
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

export const WEIXIN_MP_PROFILE: ArticleProfile = {
  platform: "wechat-mp",
  uploadUrl: "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=10",
  selectors: {
    loginIndicator: "#account-name",
    titleInput: "#title",
    bodyInput: "#ueditor_0",
    imageInput: "input[type='file'][accept*='image']",
    publishButton: "button:has-text('群发')",
    successToast: "div:has-text('已群发')",
  },
  captionSpec: { captionMaxChars: 64, maxTags: 3, scheduleMinAheadMinutes: 0 },
  humanPace: { typeDelayMs: 70, pageWaitMs: 2_500, postUploadWaitMs: 6_000 },
  tier: "rpa",
};

export function createWeixinMpAdapter(): ArticleAdapter {
  return {
    profile: WEIXIN_MP_PROFILE,
    loginCheck: (driver: BrowserDriver) =>
      driver.isLoggedIn(WEIXIN_MP_PROFILE.uploadUrl, WEIXIN_MP_PROFILE.selectors.loginIndicator),
    upload: (driver: BrowserDriver, input: ArticleUploadInput): Promise<UploadResult> =>
      uploadArticleByProfile(WEIXIN_MP_PROFILE, driver, input),
    receiptProbe: (driver: BrowserDriver, ctx: { taskId: string; upload: UploadResult }): Promise<PublishReceipt> =>
      probeArticleByProfile(WEIXIN_MP_PROFILE, driver, ctx),
  };
}
