/**
 * bundles/ip-ledger —— IP 授权台账纯函数（ACT-B-10 / REF-P-05）
 *
 * 纪律：
 *  - 无凭证不使用：license_status 非 granted/valid 一律禁止使用；
 *  - 范围逐维校验：用途（purpose）/ 平台（platform）/ 地域（territory）/ 期限（period）四维全覆盖才放行；
 *  - 到期三档预警（30/7/1 天）+ 已过期硬阻断；到期未续自动下架关联在用清单；
 *  - 只增不改：本模块只做判定，不写库；授权变更由 ip_asset 新记录链回旧记录。
 */

export interface IpAsset {
  id: string;
  name: string;
  kind: "music" | "font" | "image" | "video" | "portrait" | "other";
  /** granted=已授权；pending=待授权；expired=已过期；unknown=无凭证 */
  licenseStatus: "granted" | "pending" | "expired" | "unknown";
  /** 授权允许的用途（如 social-post / ad-boost / ota-listing / ugc-repost） */
  purposes: string[];
  /** 授权允许的平台（* = 不限） */
  platforms: string[];
  /** 授权地域（CN / global / 具体国家码） */
  territories: string[];
  /** ISO 日期（含当天有效） */
  validFrom: string;
  validTo: string;
  /** 来源凭证 URI（合同/截图/平台授权页） */
  evidenceUri: string | null;
}

export interface IpUsage {
  purpose: string;
  platform: string;
  territory: string;
  at: string;
}

export interface IpCheckResult {
  allowed: boolean;
  reasons: string[];
  /** 命中围栏时给出规则号（G-AD1 广告标识 / G-AD2 第三方素材授权） */
  rule: "G-AD2" | null;
}

export interface IpExpiryAlert {
  assetId: string;
  name: string;
  daysLeft: number;
  tier: 30 | 7 | 1 | 0;
  expired: boolean;
}

const dayMs = 86_400_000;
const asSet = (values: string[]): Set<string> => new Set(values.map((v) => v.trim().toLowerCase()));

/**
 * 使用范围校验：四维（用途/平台/地域/期限）全覆盖才放行；无凭证直接阻断（G-AD2）。
 * 任一维度缺失或不覆盖 → allowed=false，理由逐条列出（供审批与战报引用）。
 */
export function checkIpUsage(asset: IpAsset, usage: IpUsage): IpCheckResult {
  const reasons: string[] = [];
  if (!asset.evidenceUri) reasons.push(`${asset.id} 无来源凭证，不得使用`);
  if (asset.licenseStatus !== "granted") reasons.push(`${asset.id} 授权状态 ${asset.licenseStatus}，不得使用`);
  const purposes = asSet(asset.purposes);
  const platforms = asSet(asset.platforms);
  const territories = asSet(asset.territories);
  if (!purposes.has(usage.purpose.toLowerCase())) reasons.push(`授权未覆盖用途 ${usage.purpose}`);
  if (!platforms.has("*") && !platforms.has(usage.platform.toLowerCase())) reasons.push(`授权未覆盖平台 ${usage.platform}`);
  if (!territories.has("*") && !territories.has(usage.territory.toLowerCase())) reasons.push(`授权未覆盖地域 ${usage.territory}`);
  const at = new Date(usage.at);
  const from = new Date(`${asset.validFrom}T00:00:00Z`);
  const to = new Date(`${asset.validTo}T23:59:59Z`);
  if (Number.isNaN(at.getTime())) reasons.push(`使用时间非法：${usage.at}`);
  else {
    if (at.getTime() < from.getTime()) reasons.push(`授权尚未生效（${asset.validFrom} 起）`);
    if (at.getTime() > to.getTime()) reasons.push(`授权已过期（${asset.validTo} 止）`);
  }
  return { allowed: reasons.length === 0, reasons, rule: reasons.length > 0 ? "G-AD2" : null };
}

/** 到期三档预警（30/7/1 天）+ 已过期（tier=0）；按剩余天数升序返回。 */
export function ipExpiryAlerts(assets: IpAsset[], now: Date, tiers: Array<30 | 7 | 1> = [30, 7, 1]): IpExpiryAlert[] {
  const alerts: IpExpiryAlert[] = [];
  for (const asset of assets) {
    if (asset.licenseStatus !== "granted") continue;
    const to = new Date(`${asset.validTo}T23:59:59Z`);
    if (Number.isNaN(to.getTime())) continue;
    const daysLeft = Math.ceil((to.getTime() - now.getTime()) / dayMs);
    if (daysLeft < 0) {
      alerts.push({ assetId: asset.id, name: asset.name, daysLeft, tier: 0, expired: true });
      continue;
    }
    const tier = [...tiers].sort((a, b) => a - b).find((t) => daysLeft <= t);
    if (tier) alerts.push({ assetId: asset.id, name: asset.name, daysLeft, tier, expired: false });
  }
  return alerts.sort((a, b) => a.daysLeft - b.daysLeft || a.assetId.localeCompare(b.assetId));
}

/** 到期未续应下架的资产清单（已过期 + 待授权 + 无凭证）。 */
export function assetsToWithdraw(assets: IpAsset[], now: Date): IpAsset[] {
  const expiredIds = new Set(ipExpiryAlerts(assets, now).filter((a) => a.expired).map((a) => a.assetId));
  return assets.filter((a) => expiredIds.has(a.id) || a.licenseStatus !== "granted");
}
