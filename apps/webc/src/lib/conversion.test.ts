import { describe, expect, it } from "vitest";
import { buildConversionRequest, conversionReady, CONVERSIONS } from "./conversion";

const fields = { contact: "13800138000", couponId: "cpn-1", preferredAt: "2026-10-01T14:00", question: "周末还有房吗？", consent: true };

describe("B-52 承接四件套前端契约", () => {
  it("四类动作固定顺序与文案", () => {
    expect(CONVERSIONS.map((c) => c.action)).toEqual(["coupon_claim", "lead_capture", "appointment", "consult"]);
  });

  it("就绪判定：授权硬前置；动作专有必填", () => {
    expect(conversionReady("lead_capture", { ...fields, consent: false })).toBe(false);
    expect(conversionReady("lead_capture", { ...fields, contact: "" })).toBe(false);
    expect(conversionReady("coupon_claim", { ...fields, couponId: "" })).toBe(false);
    expect(conversionReady("appointment", { ...fields, preferredAt: "" })).toBe(false);
    expect(conversionReady("consult", { ...fields, question: "好" })).toBe(false);
    for (const c of CONVERSIONS) expect(conversionReady(c.action, fields)).toBe(true);
  });

  it("请求体：授权恒为 true、来源链带 action 入口、咨询不带联系方式", () => {
    const coupon = buildConversionRequest("coupon_claim", fields);
    expect(coupon.input).toMatchObject({ contact: "13800138000", consent: true, entry: "coupon_claim", couponId: "cpn-1" });
    const consult = buildConversionRequest("consult", fields);
    expect(consult.input.contact).toBeUndefined();
    expect(consult.input.question).toContain("周末");
  });
});
