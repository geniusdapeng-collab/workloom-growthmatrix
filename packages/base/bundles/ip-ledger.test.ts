/**
 * B-47 授权台账测试：四维使用范围校验、三档到期预警、到期下架清单。
 */
import { describe, expect, it } from "vitest";
import { assetsToWithdraw, checkIpUsage, ipExpiryAlerts, type IpAsset } from "./ip-ledger.js";

const base: IpAsset = {
  id: "ip-music-1",
  name: "片头 BGM（商用授权）",
  kind: "music",
  licenseStatus: "granted",
  purposes: ["social-post", "ad-boost"],
  platforms: ["douyin", "xiaohongshu"],
  territories: ["cn"],
  validFrom: "2026-01-01",
  validTo: "2026-12-31",
  evidenceUri: "https://contracts.example/ip-music-1",
};

const usage = { purpose: "social-post", platform: "douyin", territory: "cn", at: "2026-09-22T10:00:00+08:00" };

describe("B-47 使用范围校验（四维全覆盖）", () => {
  it("四维全覆盖 → 放行", () => {
    expect(checkIpUsage(base, usage)).toMatchObject({ allowed: true, rule: null });
  });

  it("无凭证 / 未授权状态 → 阻断（G-AD2）", () => {
    const noEvidence = { ...base, evidenceUri: null };
    const pending = { ...base, licenseStatus: "pending" as const };
    const r1 = checkIpUsage(noEvidence, usage);
    const r2 = checkIpUsage(pending, usage);
    expect(r1.allowed).toBe(false);
    expect(r1.rule).toBe("G-AD2");
    expect(r1.reasons.join("；")).toContain("无来源凭证");
    expect(r2.allowed).toBe(false);
    expect(r2.reasons.join("；")).toContain("授权状态 pending");
  });

  it("用途/平台/地域任一不覆盖 → 逐条给出理由", () => {
    const r = checkIpUsage(base, { ...usage, purpose: "ota-listing", platform: "weibo", territory: "us" });
    expect(r.allowed).toBe(false);
    expect(r.reasons.join("；")).toContain("未覆盖用途 ota-listing");
    expect(r.reasons.join("；")).toContain("未覆盖平台 weibo");
    expect(r.reasons.join("；")).toContain("未覆盖地域 us");
  });

  it("通配授权（*）覆盖任意平台/地域；过期时间段仍阻断", () => {
    const wildcard = { ...base, platforms: ["*"], territories: ["*"] };
    expect(checkIpUsage(wildcard, { ...usage, platform: "tiktok", territory: "us" }).allowed).toBe(true);
    const expired = checkIpUsage(base, { ...usage, at: "2027-01-05T10:00:00+08:00" });
    expect(expired.allowed).toBe(false);
    expect(expired.reasons.join("；")).toContain("已过期");
  });
});

describe("B-47 到期预警与下架清单", () => {
  const now = new Date("2026-09-22T00:00:00Z");
  const withTo = (id: string, validTo: string, extra: Partial<IpAsset> = {}): IpAsset => ({
    ...base, id, name: id, validTo, ...extra,
  });

  it("三档预警：20 天→30 档、5 天→7 档、当天→1 档、过期→0 档；45 天不进预警", () => {
    const alerts = ipExpiryAlerts([
      withTo("ip-45", "2026-11-06"),
      withTo("ip-20", "2026-10-12"),
      withTo("ip-5", "2026-09-27"),
      withTo("ip-0", "2026-09-22"),
      withTo("ip-expired", "2026-09-01"),
    ], now);
    expect(alerts.map((a) => `${a.assetId}:${a.tier}`)).toEqual([
      "ip-expired:0", "ip-0:1", "ip-5:7", "ip-20:30",
    ]);
    expect(alerts[0]!.expired).toBe(true);
  });

  it("下架清单：已过期 + 待授权 + 无凭证；有效授权不在列", () => {
    const assets = [
      base,
      withTo("ip-expired", "2026-09-01"),
      withTo("ip-pending", "2026-12-31", { licenseStatus: "pending" }),
      withTo("ip-unknown", "2026-12-31", { licenseStatus: "unknown" }),
    ];
    const ids = assetsToWithdraw(assets, now).map((a) => a.id).sort();
    expect(ids).toEqual(["ip-expired", "ip-pending", "ip-unknown"]);
  });
});
