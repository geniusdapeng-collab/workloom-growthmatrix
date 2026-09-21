/**
 * C 端承接动作（B-52 / REF-P-10）：领券 / 留资 / 预约 / 咨询。
 *
 * 定位：C 端服务前台从「客服形态」扩展出「承接转化形态」——四类动作都落到 c_tickets
 * （kind=动作名）+ 五元事件，形成可回执、可派单、可归因的线索起点：
 *  - 来源链（渠道 + 内容 ID + 入口）随动作一起落库，成交归因的数据起点；
 *  - 联系方式一律先脱敏再落 payload（明文由客户系统持有，凭据只留脱敏）；
 *  - 个人信息使用授权（consent）是硬前置，缺失直接拒（R24 同源纪律）。
 */

export const CONVERSION_ACTIONS = ["coupon_claim", "lead_capture", "appointment", "consult"] as const;
export type ConversionAction = (typeof CONVERSION_ACTIONS)[number];

export interface ConversionInput {
  /** 客户联系方式（手机号/微信号）；留资/领券/预约必填 */
  contact?: string;
  name?: string;
  /** 来源链 */
  channel?: string;
  contentId?: string;
  entry?: string;
  /** 领券：券 ID */
  couponId?: string;
  /** 预约：期望时间（ISO 或人类可读） */
  preferredAt?: string;
  /** 咨询：问题正文 */
  question?: string;
  /** 个人信息使用授权（硬前置） */
  consent: boolean;
}

export interface ConversionTicket {
  kind: ConversionAction;
  title: string;
  payload: Record<string, unknown>;
}

/** 联系方式脱敏：手机号保留前三后四；其余保留首尾各 1–2 字符。 */
export function maskContact(contact: string): string {
  const value = contact.trim();
  if (/^1[3-9]\d{9}$/.test(value)) return `${value.slice(0, 3)}****${value.slice(-4)}`;
  if (value.length <= 4) return `${value[0] ?? ""}***`;
  return `${value.slice(0, 2)}***${value.slice(-1)}`;
}

const TITLES: Record<ConversionAction, string> = {
  coupon_claim: "领券申请",
  lead_capture: "留资登记",
  appointment: "预约登记",
  consult: "咨询登记",
};

/**
 * 构造承接工单（纯函数，供路由与测试共用）：
 * 校验动作专属必填字段 + 授权前置；payload 只落脱敏联系方式与来源链。
 */
export function buildConversionTicket(action: ConversionAction, input: ConversionInput, now = new Date()): ConversionTicket {
  if (!CONVERSION_ACTIONS.includes(action)) throw new Error(`未知承接动作 ${action}`);
  if (input.consent !== true) throw new Error("需先同意个人信息使用授权");
  const contact = input.contact?.trim() ?? "";
  if (action !== "consult" && !contact) throw new Error("留资/领券/预约需提供联系方式");
  if (action === "coupon_claim" && !input.couponId?.trim()) throw new Error("领券需提供券 ID");
  if (action === "appointment" && !input.preferredAt?.trim()) throw new Error("预约需提供期望时间");
  if (action === "consult" && (input.question?.trim().length ?? 0) < 2) throw new Error("咨询需提供问题正文");
  const payload: Record<string, unknown> = {
    action,
    name: input.name?.trim() || undefined,
    contactMasked: contact ? maskContact(contact) : undefined,
    consent: true,
    consentAt: now.toISOString(),
    source: {
      channel: input.channel?.trim() || "h5",
      contentId: input.contentId?.trim() || undefined,
      entry: input.entry?.trim() || undefined,
    },
    ...(action === "coupon_claim" ? { couponId: input.couponId!.trim() } : {}),
    ...(action === "appointment" ? { preferredAt: input.preferredAt!.trim() } : {}),
    ...(action === "consult" ? { question: input.question!.trim() } : {}),
    note: "联系方式明文由客户系统持有；本凭据仅留脱敏值与来源链（R24/G-GROW6）",
  };
  return { kind: action, title: TITLES[action], payload };
}
