/**
 * bundles/ugc-flow —— UGC 征集与授权流程纯函数（第一批 §6.3/§8.4 · ADD-P-05 延伸）
 *
 * 纪律（四条硬线，任一不满足不得进入二次发布）：
 *  ① 授权回收：无授权凭证/范围不覆盖 → G-AD2 block；
 *  ② 去个人信息：手机号/证件号/订单号等未脱敏 → G-GROW6 block；
 *  ③ 肖像授权：出现可识别人物必须有肖像同意 → G-AD2 block；
 *  ④ 广告标识：用于营销投放必须带广告标识 → G-AD1 block。
 *  署名（attribution）缺失同样阻断（授权范围通常要求署名）。
 */

export interface UgcLicenseScope {
  purposes: string[];
  platforms: string[];
  territories: string[];
  validFrom: string;
  validTo: string;
}

export interface UgcSubmission {
  id: string;
  /** 来源渠道（如 xiaohongshu-comment / douyin-dm / wecom-group） */
  source: string;
  authorHandle: string;
  collectedAt: string;
  hasIdentifiablePerson: boolean;
  portraitConsent: boolean;
  licenseScope: UgcLicenseScope | null;
  licenseEvidenceUri: string | null;
  piiStripped: boolean;
  attribution: string | null;
  adDisclosure: boolean;
}

export interface UgcPublishUsage {
  purpose: string;
  platform: string;
  territory: string;
  at: string;
  isAdvertisement: boolean;
}

export interface UgcPublishReview {
  allowed: boolean;
  blockers: string[];
  /** 命中的规则号（去重）：G-AD1 广告标识 / G-AD2 授权与肖像 / G-GROW6 数据边界 */
  rules: Array<"G-AD1" | "G-AD2" | "G-GROW6">;
}

const asSet = (values: string[]): Set<string> => new Set(values.map((v) => v.trim().toLowerCase()));

/** 是否覆盖用途/平台/地域/期限（平台与地域支持 *）。 */
export function scopeCovers(scope: UgcLicenseScope, usage: UgcPublishUsage): string[] {
  const reasons: string[] = [];
  const purposes = asSet(scope.purposes);
  const platforms = asSet(scope.platforms);
  const territories = asSet(scope.territories);
  if (!purposes.has(usage.purpose.toLowerCase())) reasons.push(`授权未覆盖用途 ${usage.purpose}`);
  if (!platforms.has("*") && !platforms.has(usage.platform.toLowerCase())) reasons.push(`授权未覆盖平台 ${usage.platform}`);
  if (!territories.has("*") && !territories.has(usage.territory.toLowerCase())) reasons.push(`授权未覆盖地域 ${usage.territory}`);
  const at = new Date(usage.at);
  const from = new Date(`${scope.validFrom}T00:00:00Z`);
  const to = new Date(`${scope.validTo}T23:59:59Z`);
  if (Number.isNaN(at.getTime())) reasons.push(`使用时间非法：${usage.at}`);
  else {
    if (at.getTime() < from.getTime()) reasons.push(`授权尚未生效（${scope.validFrom} 起）`);
    if (at.getTime() > to.getTime()) reasons.push(`授权已过期（${scope.validTo} 止）`);
  }
  return reasons;
}

/** 二次发布前审查：四条硬线逐项检查，返回全部阻断理由与命中规则。 */
export function reviewUgcForPublish(submission: UgcSubmission, usage: UgcPublishUsage): UgcPublishReview {
  const blockers: string[] = [];
  const rules = new Set<"G-AD1" | "G-AD2" | "G-GROW6">();
  if (!submission.licenseScope) {
    blockers.push(`${submission.id} 无授权范围声明`);
    rules.add("G-AD2");
  } else {
    const scopeReasons = scopeCovers(submission.licenseScope, usage);
    if (scopeReasons.length > 0) {
      blockers.push(...scopeReasons.map((r) => `${submission.id}：${r}`));
      rules.add("G-AD2");
    }
  }
  if (!submission.licenseEvidenceUri) {
    blockers.push(`${submission.id} 无授权凭证（截图/授权书/平台授权页）`);
    rules.add("G-AD2");
  }
  if (submission.hasIdentifiablePerson && !submission.portraitConsent) {
    blockers.push(`${submission.id} 出现可识别人物但无肖像同意`);
    rules.add("G-AD2");
  }
  if (!submission.piiStripped) {
    blockers.push(`${submission.id} 未完成去个人信息（手机号/证件号/订单号等）`);
    rules.add("G-GROW6");
  }
  if (!submission.attribution) {
    blockers.push(`${submission.id} 缺署名（作者/来源）`);
    rules.add("G-AD2");
  }
  if (usage.isAdvertisement && !submission.adDisclosure) {
    blockers.push(`${submission.id} 用于营销投放但缺广告标识`);
    rules.add("G-AD1");
  }
  return { allowed: blockers.length === 0, blockers, rules: [...rules] };
}

/**
 * UGC 文本去个人信息：手机号 → 前三后四，长数字订单号/证件号 → 保留末四位。
 * 只做必要脱敏，不改变文案语义；脱敏结果写回 submission.piiStripped 前的人工复核仍需可见。
 */
export function maskUgcPii(text: string): string {
  return text
    .replace(/(?<!\d)(1[3-9]\d)\d{4}(\d{4})(?!\d)/g, "$1****$2")
    .replace(/(?<!\d)(\d{6,})\d{4}(?!\d)/g, (_, head: string) => `${head}****`);
}
