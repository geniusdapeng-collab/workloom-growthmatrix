/**
 * B-18 国内图文通道测试：五通道注册表、就绪分级、文案硬校验、占位通道 fail-closed。
 */
import { describe, expect, it } from "vitest";
import { createTextChannelAdapters } from "./adapters/text-channels.js";
import type { ArticleUploadInput, BrowserDriver } from "./adapters/base.js";
import { AdapterSpecError } from "./adapters/base.js";
import { PlatformSchema } from "./types.js";

class FakeDriver implements BrowserDriver {
  calls: string[] = [];
  constructor(private readonly loggedIn = true) {}
  goto(url: string) { this.calls.push(`goto:${url}`); return Promise.resolve(); }
  isLoggedIn() { return Promise.resolve(this.loggedIn); }
  uploadFile(selector: string, path: string) { this.calls.push(`upload:${selector}:${path}`); return Promise.resolve(); }
  typeText(selector: string, text: string) { this.calls.push(`type:${selector}:${text.slice(0, 12)}`); return Promise.resolve(); }
  click(selector: string) { this.calls.push(`click:${selector}`); return Promise.resolve(); }
  waitForSelector() { return Promise.resolve(true); }
  wait(ms: number) { this.calls.push(`wait:${ms}`); return Promise.resolve(); }
}

const article: ArticleUploadInput = {
  title: "秋季激光切割机保养指南",
  body: "换季保养清单与常见故障排查。",
  imagePaths: ["/tmp/a.png"],
  tags: ["激光切割", "设备保养"],
};

describe("B-18 图文通道注册表与平台枚举", () => {
  it("五通道：2 个 rpa 骨架 + 3 个占位；平台枚举接受全部新值", () => {
    const adapters = createTextChannelAdapters();
    expect(adapters.map((a) => a.profile.platform).sort()).toEqual(["baijia", "toutiao", "wechat-mp", "weibo", "zhihu"]);
    const rpa = adapters.filter((a) => a.profile.tier === "rpa").map((a) => a.profile.platform).sort();
    const placeholder = adapters.filter((a) => a.profile.tier === "placeholder").map((a) => a.profile.platform).sort();
    expect(rpa).toEqual(["wechat-mp", "weibo"]);
    expect(placeholder).toEqual(["baijia", "toutiao", "zhihu"]);
    for (const id of ["wechat-mp", "weibo", "zhihu", "toutiao", "baijia"]) {
      expect(PlatformSchema.safeParse(id).success).toBe(true);
    }
    expect(PlatformSchema.safeParse("unknown-channel").success).toBe(false);
  });

  it("rpa 骨架：登录检测 → 标题/正文/配图/话题 → 发布 → 回执", async () => {
    const adapter = createTextChannelAdapters().find((a) => a.profile.platform === "wechat-mp")!;
    const driver = new FakeDriver(true);
    expect(await adapter.loginCheck(driver)).toBe(true);
    const upload = await adapter.upload(driver, article);
    expect(upload.evidenceUri).toContain("rpa-evidence://wechat-mp/");
    expect(driver.calls.some((c) => c.startsWith("type:#title"))).toBe(true);
    expect(driver.calls.some((c) => c.startsWith("upload:"))).toBe(true);
    const receipt = await adapter.receiptProbe(driver, { taskId: "task-1", upload });
    expect(receipt).toMatchObject({ taskId: "task-1", platform: "wechat-mp", synced: true });
  });

  it("文案硬校验：标题超限与未提供图片位直接拒（不进入编辑器）", async () => {
    const adapter = createTextChannelAdapters().find((a) => a.profile.platform === "weibo")!;
    const driver = new FakeDriver();
    await expect(adapter.upload(driver, { ...article, title: "x".repeat(31) })).rejects.toBeInstanceOf(AdapterSpecError);
    const noImageSlot = createTextChannelAdapters().find((a) => a.profile.platform === "wechat-mp")!;
    const profileWithoutImage = { ...noImageSlot.profile, selectors: { ...noImageSlot.profile.selectors, imageInput: undefined } };
    await expect(
      (await import("./adapters/base.js")).uploadArticleByProfile(profileWithoutImage as never, driver, article),
    ).rejects.toBeInstanceOf(AdapterSpecError);
  });

  it("占位通道 fail-closed：登录恒 false、upload 拒绝且无回执", async () => {
    const adapter = createTextChannelAdapters().find((a) => a.profile.platform === "zhihu")!;
    const driver = new FakeDriver();
    expect(await adapter.loginCheck(driver)).toBe(false);
    await expect(adapter.upload(driver, article)).rejects.toThrow(/占位/);
    const receipt = await adapter.receiptProbe(driver, { taskId: "task-2", upload: {} });
    expect(receipt.synced).toBe(false);
  });
});
