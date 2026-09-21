/**
 * B-23 桌面发布 worker 测试：成功回执、登录失败/缺适配器/执行异常全 fail-closed。
 */
import { describe, expect, it, vi } from "vitest";
import { executeArticlePublish, executePublish, type PublishWorkerTask } from "./publish-worker.mjs";
import type { ArticleAdapter, BrowserDriver, PublishAdapter } from "@workloom/base/publish-rpa";

const driver = {
  goto: vi.fn(async () => undefined),
  isLoggedIn: vi.fn(async () => true),
  uploadFile: vi.fn(async () => undefined),
  typeText: vi.fn(async () => undefined),
  click: vi.fn(async () => undefined),
  waitForSelector: vi.fn(async () => true),
  wait: vi.fn(async () => undefined),
} as unknown as BrowserDriver;

const task: PublishWorkerTask = {
  taskId: "pt-1",
  platform: "douyin",
  input: { videoPath: "/tmp/final.mp4", caption: "夏日新品", tags: ["数码"] },
};

function adapterOf(over: Partial<PublishAdapter> = {}): PublishAdapter {
  return {
    profile: { platform: "douyin" } as never,
    loginCheck: vi.fn(async () => true),
    upload: vi.fn(async () => ({ evidenceUri: "rpa-evidence://douyin/1" })),
    receiptProbe: vi.fn(async () => ({
      taskId: "pt-1", platform: "douyin" as const, synced: true, evidenceUri: "rpa-evidence://douyin/1",
      verifiedAt: new Date().toISOString(),
    })),
    ...over,
  };
}

describe("B-23 publish-worker 执行", () => {
  it("登录通过 + 上传成功 + 回执 → ok:true 且透传回执", async () => {
    const upload = vi.fn(async () => ({ evidenceUri: "rpa-evidence://douyin/1" }));
    const result = await executePublish(task, { driver, adapters: { douyin: adapterOf({ upload }) } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.receipt).toMatchObject({ synced: true, platform: "douyin" });
    expect(upload).toHaveBeenCalledOnce();
  });

  it("未登录 → LOGIN_REQUIRED，且不上传", async () => {
    const upload = vi.fn();
    const result = await executePublish(task, {
      driver,
      adapters: { douyin: adapterOf({ loginCheck: async () => false, upload: upload as never }) },
    });
    expect(result).toEqual({ ok: false, error: "LOGIN_REQUIRED" });
    expect(upload).not.toHaveBeenCalled();
  });

  it("缺适配器 → NO_ADAPTER；适配器抛错 → 原样失败（不伪造回执）", async () => {
    // douyin 有内置适配器；用无内置的图文平台验证「缺适配器」路径
    expect(await executePublish({ ...task, platform: "wechat-mp" as never }, { driver, adapters: {} }))
      .toEqual({ ok: false, error: "NO_ADAPTER:wechat-mp" });
    const result = await executePublish(task, {
      driver,
      adapters: { douyin: adapterOf({ upload: async () => { throw new Error("浏览器崩溃"); } }) },
    });
    expect(result).toEqual({ ok: false, error: "浏览器崩溃" });
  });

  it("回执 synced=false → NO_RECEIPT（无回执不算完成）", async () => {
    const result = await executePublish(task, {
      driver,
      adapters: { douyin: adapterOf({ receiptProbe: async () => ({ taskId: "pt-1", platform: "douyin", synced: false }) }) },
    });
    expect(result).toEqual({ ok: false, error: "NO_RECEIPT" });
  });

  it("图文通道执行：成功回执与缺适配器两条路径", async () => {
    const articleAdapter: ArticleAdapter = {
      profile: { platform: "wechat-mp", tier: "rpa" } as never,
      loginCheck: async () => true,
      upload: async () => ({ evidenceUri: "rpa-evidence://wechat-mp/1" }),
      receiptProbe: async () => ({ taskId: "pt-2", platform: "wechat-mp", synced: true, verifiedAt: new Date().toISOString() }),
    };
    const ok = await executeArticlePublish(
      { taskId: "pt-2", platform: "wechat-mp", input: { title: "标题", body: "正文", imagePaths: [], tags: [] } },
      { driver, adapters: { "wechat-mp": articleAdapter } },
    );
    expect(ok.ok).toBe(true);
    const missing = await executeArticlePublish(
      { taskId: "pt-3", platform: "weibo", input: { title: "标题", body: "正文", imagePaths: [], tags: [] } },
      { driver, adapters: {} },
    );
    expect(missing).toEqual({ ok: false, error: "NO_ADAPTER:weibo" });
  });
});
