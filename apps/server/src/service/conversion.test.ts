/**
 * B-52 承接动作契约测试：四类动作必填、授权硬前置、联系方式脱敏、来源链留存。
 */
import { describe, expect, it } from "vitest";
import { buildConversionTicket, CONVERSION_ACTIONS, maskContact } from "./conversion.js";

const now = new Date("2026-09-22T01:00:00Z");

describe("B-52 承接动作", () => {
  it("四类动作齐备且标题固定", () => {
    expect(CONVERSION_ACTIONS).toEqual(["coupon_claim", "lead_capture", "appointment", "consult"]);
    for (const action of CONVERSION_ACTIONS) {
      const input = action === "consult"
        ? { consent: true, question: "想问下周末还有房吗" }
        : action === "appointment"
          ? { consent: true, contact: "13800138000", preferredAt: "2026-10-01 14:00" }
          : action === "coupon_claim"
            ? { consent: true, contact: "13800138000", couponId: "cpn-1" }
            : { consent: true, contact: "13800138000" };
      expect(buildConversionTicket(action, input, now).kind).toBe(action);
    }
  });

  it("未授权 → 拒绝（硬前置）；动作专有必填缺失 → 拒绝", () => {
    expect(() => buildConversionTicket("lead_capture", { consent: false, contact: "13800138000" })).toThrow(/授权/);
    expect(() => buildConversionTicket("lead_capture", { consent: true })).toThrow(/联系方式/);
    expect(() => buildConversionTicket("coupon_claim", { consent: true, contact: "13800138000" })).toThrow(/券 ID/);
    expect(() => buildConversionTicket("appointment", { consent: true, contact: "13800138000" })).toThrow(/期望时间/);
    expect(() => buildConversionTicket("consult", { consent: true, question: "问" })).toThrow(/问题正文/);
  });

  it("payload 只落脱敏联系方式 + 来源链 + 授权时间", () => {
    const ticket = buildConversionTicket("coupon_claim", {
      consent: true, contact: "13800138000", couponId: "cpn-1",
      channel: "xiaohongshu", contentId: "content-9", entry: "note-cta",
    }, now);
    expect(ticket.title).toBe("领券申请");
    expect(ticket.payload).toMatchObject({
      action: "coupon_claim",
      contactMasked: "138****8000",
      consent: true,
      consentAt: now.toISOString(),
      source: { channel: "xiaohongshu", contentId: "content-9", entry: "note-cta" },
      couponId: "cpn-1",
    });
    expect(JSON.stringify(ticket.payload)).not.toContain("13800138000");
  });

  it("脱敏函数：手机号前三后四；短值不泄露", () => {
    expect(maskContact("13800138000")).toBe("138****8000");
    expect(maskContact("wx_lily")).toBe("wx***y");
    expect(maskContact("12")).toBe("1***");
  });
});
