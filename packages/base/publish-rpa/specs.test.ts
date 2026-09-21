import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPlatformSpecs, resolvePlatform, validatePublishInput } from "./specs.js";

const specPath = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "bundles",
  "geo-growth",
  "templates",
  "platform-specs.json",
);

const specs = loadPlatformSpecs(specPath);

describe("平台规格注册表", () => {
  it("注册表可加载，覆盖国内外主要平台并含来源与复核字段", () => {
    expect(specs.platforms.length).toBe(23);
    expect(specs.platforms.filter((platform) => platform.status === "verified").length).toBeGreaterThanOrEqual(5);
    for (const platform of specs.platforms) {
      expect(platform.source.length).toBeGreaterThan(0);
      expect(platform.reviewDue).toBeTruthy();
    }
    expect(resolvePlatform(specs, "小红书")?.kind).toBe("platform");
    expect(resolvePlatform(specs, "xhs")?.kind).toBe("platform");
    expect(resolvePlatform(specs, "全平台")?.kind).toBe("group");
    expect(resolvePlatform(specs, "从未听说过的平台")).toBeNull();
  });

  it("抖音：标题/话题/定时越界即报错，合规输入通过", () => {
    const base = { platform: "抖音", caption: "hello", tags: ["a"], now: new Date("2026-09-21T10:00:00+08:00") };
    expect(validatePublishInput(specs, { ...base, title: "x".repeat(56) }).issues.map((issue) => issue.code)).toContain("title-too-long");
    expect(validatePublishInput(specs, { ...base, tags: ["a", "b", "c", "d", "e", "f"] }).issues.map((issue) => issue.code)).toContain("tags-exceed");
    expect(
      validatePublishInput(specs, { ...base, scheduleAt: "2026-09-21T11:00:00+08:00" }).issues.map((issue) => issue.code),
    ).toContain("schedule-too-soon");
    const ok = validatePublishInput(specs, {
      ...base,
      title: "周末亲子房",
      scheduleAt: "2026-09-21T12:30:00+08:00",
      coverWidth: 1080,
      coverHeight: 1920,
    });
    expect(ok.ok).toBe(true);
    expect(ok.platformId).toBe("douyin");
  });

  it("小红书：不支持定时；封面比例不符报错；3:4 通过", () => {
    const notSupported = validatePublishInput(specs, {
      platform: "小红书",
      scheduleAt: "2026-09-22T10:00:00+08:00",
    });
    expect(notSupported.ok).toBe(false);
    expect(notSupported.issues.map((issue) => issue.code)).toContain("schedule-unsupported");

    const badRatio = validatePublishInput(specs, { platform: "小红书", coverWidth: 1920, coverHeight: 1080 });
    expect(badRatio.issues.map((issue) => issue.code)).toContain("cover-ratio-mismatch");

    const ok = validatePublishInput(specs, { platform: "小红书", coverWidth: 1242, coverHeight: 1660, tags: ["亲子酒店"] });
    expect(ok.ok).toBe(true);
  });

  it("未复核平台在对外发布模式下必须报错，内部预览只告警", () => {
    const preview = validatePublishInput(specs, { platform: "公众号", title: "秋季上新" });
    expect(preview.ok).toBe(true);
    expect(preview.issues.map((issue) => issue.code)).toContain("platform-needs-review");

    const live = validatePublishInput(specs, { platform: "公众号", title: "秋季上新" }, { requireVerified: true });
    expect(live.ok).toBe(false);
  });

  it("OTA 素材：图片数量低于下限报错", () => {
    const verdict = validatePublishInput(specs, { platform: "携程", imageCount: 5 });
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.map((issue) => issue.code)).toContain("image-count-below-min");
  });

  it("未登记平台直接拒绝", () => {
    const verdict = validatePublishInput(specs, { platform: "不存在的平台" });
    expect(verdict.ok).toBe(false);
    expect(verdict.issues[0]?.code).toBe("unknown-platform");
  });
});
