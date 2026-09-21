/**
 * B-82 UGC 征集与授权流程测试：四线硬约束 + 去个人信息 + 岗位工具声明。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { maskUgcPii, reviewUgcForPublish, scopeCovers, type UgcSubmission } from "./ugc-flow.js";

const bundleDir = join(import.meta.dirname, "..", "..", "..", "bundles", "geo-growth");
const usage = { purpose: "social-post", platform: "xiaohongshu", territory: "cn", at: "2026-09-22T10:00:00+08:00", isAdvertisement: false };
const compliant: UgcSubmission = {
  id: "ugc-1",
  source: "xiaohongshu-comment",
  authorHandle: "@guest_lily",
  collectedAt: "2026-09-21T12:00:00+08:00",
  hasIdentifiablePerson: true,
  portraitConsent: true,
  licenseScope: { purposes: ["social-post", "ad-boost"], platforms: ["xiaohongshu"], territories: ["cn"], validFrom: "2026-09-01", validTo: "2027-08-31" },
  licenseEvidenceUri: "https://contracts.example/ugc-1",
  piiStripped: true,
  attribution: "@guest_lily",
  adDisclosure: true,
};

describe("B-82 UGC 二次发布四线审查", () => {
  it("四线齐全 → 放行", () => {
    expect(reviewUgcForPublish(compliant, usage)).toEqual({ allowed: true, blockers: [], rules: [] });
  });

  it("无授权/无凭证/范围不覆盖 → G-AD2 阻断", () => {
    const noLicense = { ...compliant, licenseScope: null };
    const noEvidence = { ...compliant, licenseEvidenceUri: null };
    const outOfScope = reviewUgcForPublish(compliant, { ...usage, platform: "douyin" });
    expect(reviewUgcForPublish(noLicense, usage).rules).toContain("G-AD2");
    expect(reviewUgcForPublish(noEvidence, usage).blockers.join("；")).toContain("无授权凭证");
    expect(outOfScope.blockers.join("；")).toContain("未覆盖平台 douyin");
  });

  it("可识别人物缺肖像同意 → G-AD2；未去个人信息 → G-GROW6", () => {
    const noPortrait = reviewUgcForPublish({ ...compliant, portraitConsent: false }, usage);
    const dirty = reviewUgcForPublish({ ...compliant, piiStripped: false }, usage);
    expect(noPortrait.blockers.join("；")).toContain("无肖像同意");
    expect(noPortrait.rules).toContain("G-AD2");
    expect(dirty.blockers.join("；")).toContain("去个人信息");
    expect(dirty.rules).toContain("G-GROW6");
  });

  it("营销投放缺广告标识 → G-AD1；缺署名 → G-AD2", () => {
    const ad = reviewUgcForPublish({ ...compliant, adDisclosure: false }, { ...usage, isAdvertisement: true });
    const noAttribution = reviewUgcForPublish({ ...compliant, attribution: null }, usage);
    expect(ad.blockers.join("；")).toContain("缺广告标识");
    expect(ad.rules).toContain("G-AD1");
    expect(noAttribution.blockers.join("；")).toContain("缺署名");
  });

  it("范围覆盖函数支持通配与期限窗口", () => {
    expect(scopeCovers({ purposes: ["social-post"], platforms: ["*"], territories: ["*"], validFrom: "2026-01-01", validTo: "2026-12-31" }, usage)).toEqual([]);
    expect(scopeCovers({ purposes: ["social-post"], platforms: ["xiaohongshu"], territories: ["cn"], validFrom: "2026-01-01", validTo: "2026-06-30" }, usage).join("；")).toContain("已过期");
  });

  it("去个人信息：手机号保留前三后四、长订单号保留头部+掩码", () => {
    expect(maskUgcPii("联系 13800138000 领奖")).toBe("联系 138****8000 领奖");
    expect(maskUgcPii("订单号 2026092200012345 已核销")).toBe("订单号 202609220001**** 已核销");
  });
});

describe("B-82 岗位声明", () => {
  it("私域承接专员声明 UGC 四工具与 G-AD1/G-AD2/G-GROW6 围栏", () => {
    const p = YAML.parse(readFileSync(join(bundleDir, "presets", "private-domain-operator.yml"), "utf8")) as {
      fence_bindings: string[];
      tools: Array<{ name: string; access: string }>;
      write_back: string[];
    };
    for (const tool of ["ugc.collect", "ugc.license.record", "ugc.pii.strip", "ugc.publish.request"]) {
      expect(p.tools.some((t) => t.name === tool && t.access === "write"), `缺写工具 ${tool}`).toBe(true);
      expect(p.write_back).toContain(tool);
    }
    expect(p.fence_bindings).toEqual(expect.arrayContaining(["G-AD1", "G-AD2", "G-GROW6"]));
  });
});
