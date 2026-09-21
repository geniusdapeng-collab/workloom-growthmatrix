/**
 * C 端承接四件套（B-52）前端契约：领券 / 留资 / 预约 / 咨询。
 * 纯函数便于单测：就绪判定 + 请求体构造（授权为硬前置；来源链随动作提交）。
 */

export type ConversionAction = "coupon_claim" | "lead_capture" | "appointment" | "consult";

export const CONVERSIONS: Array<{ action: ConversionAction; title: string; desc: string; icon: string }> = [
  { action: "coupon_claim", title: "领券", desc: "领取专属优惠券", icon: "券" },
  { action: "lead_capture", title: "留资", desc: "留下联系方式，专属顾问跟进", icon: "资" },
  { action: "appointment", title: "预约", desc: "预约到店/看房/体验时间", icon: "约" },
  { action: "consult", title: "咨询", desc: "先问清楚再决定", icon: "问" },
];

export interface ConversionFields {
  contact: string;
  couponId: string;
  preferredAt: string;
  question: string;
  consent: boolean;
}

/** 提交前就绪判定：授权必选；留资/领券/预约需联系方式；动作专有字段各自必填。 */
export function conversionReady(action: ConversionAction, fields: ConversionFields): boolean {
  if (!fields.consent) return false;
  if (action === "consult") return fields.question.trim().length >= 2;
  if (!fields.contact.trim()) return false;
  if (action === "coupon_claim") return fields.couponId.trim().length > 0;
  if (action === "appointment") return fields.preferredAt.trim().length > 0;
  return true;
}

export interface ConversionRequest {
  action: ConversionAction;
  input: {
    contact?: string; consent: true; channel: string; entry: ConversionAction;
    couponId?: string; preferredAt?: string; question?: string;
  };
}

export function buildConversionRequest(
  action: ConversionAction, fields: ConversionFields, channel = "h5-service-front",
): ConversionRequest {
  return {
    action,
    input: {
      ...(action === "consult" ? {} : { contact: fields.contact.trim() }),
      consent: true,
      channel,
      entry: action,
      ...(action === "coupon_claim" ? { couponId: fields.couponId.trim() } : {}),
      ...(action === "appointment" ? { preferredAt: fields.preferredAt.trim() } : {}),
      ...(action === "consult" ? { question: fields.question.trim() } : {}),
    },
  };
}
