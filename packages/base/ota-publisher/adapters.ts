/**
 * ota-publisher · 三通道适配器（携程/美团/飞猪）
 *
 * 纪律：
 *  - 未配置凭证 → readiness=unconfigured；upload/probe 返回 `{synced:false,status:"unknown"}`，
 *    绝不伪造平台素材 ID 或审核通过；
 *  - 预检（preflight）是纯函数：素材类型/体积/相册序位不过直接拒；
 *  - 审核状态回写只认平台返回（approved/rejected），pending 不当作通过。
 */
import {
  OtaAssetSchema,
  type OtaAsset,
  type OtaContext,
  type OtaChannel,
  type OtaChannelSpec,
  type OtaReviewStatus,
  type OtaUploadReceipt,
} from "./types.js";

const MB = 1024 * 1024;

export const OTA_SPECS: Record<OtaChannel, OtaChannelSpec> = {
  ctrip: {
    channel: "ctrip",
    label: "携程商家后台",
    auth: ["CTRIP_OTA_URL", "CTRIP_OTA_TOKEN"],
    supportedKinds: ["room_photo", "album", "video"],
    limits: { maxImageBytes: 10 * MB, maxVideoBytes: 200 * MB, maxVideoSeconds: 120, albumMaxItems: 50 },
    docs: "docs/connectors-mock-exit.md#ctrip",
  },
  meituan: {
    channel: "meituan",
    label: "美团商家后台",
    auth: ["MEITUAN_OTA_URL", "MEITUAN_OTA_TOKEN"],
    // 美团相册/房型图为主，视频素材走独立视频号通道（本适配器不覆盖）
    supportedKinds: ["room_photo", "album"],
    limits: { maxImageBytes: 8 * MB, maxVideoBytes: 100 * MB, maxVideoSeconds: 60, albumMaxItems: 40 },
    docs: "docs/connectors-mock-exit.md#meituan",
  },
  fliggy: {
    channel: "fliggy",
    label: "飞猪商家后台",
    auth: ["FLIGGY_OTA_URL", "FLIGGY_OTA_TOKEN"],
    supportedKinds: ["room_photo", "album", "video"],
    limits: { maxImageBytes: 10 * MB, maxVideoBytes: 300 * MB, maxVideoSeconds: 180, albumMaxItems: 60 },
    docs: "docs/connectors-mock-exit.md#fliggy",
  },
};

export interface OtaReadiness {
  channel: OtaChannel;
  label: string;
  state: "ready" | "unconfigured";
  detail: string;
}

export function otaReadiness(ctx: OtaContext = {}): OtaReadiness[] {
  const env = ctx.env ?? process.env;
  return Object.values(OTA_SPECS).map((spec) => {
    const missing = spec.auth.filter((key) => !env[key]?.trim());
    return missing.length === 0
      ? { channel: spec.channel, label: spec.label, state: "ready", detail: "凭证已配置（可 live 上传）" }
      : { channel: spec.channel, label: spec.label, state: "unconfigured", detail: `缺少：${missing.join("、")}（fail-closed，不回退 mock）` };
  });
}

export interface OtaAdapter {
  readonly spec: OtaChannelSpec;
  ready(ctx?: OtaContext): boolean;
  preflight(asset: OtaAsset): { ok: boolean; reasons: string[] };
  upload(asset: OtaAsset, ctx?: OtaContext): Promise<OtaUploadReceipt>;
  probeReceipt(platformAssetId: string, ctx?: OtaContext): Promise<OtaUploadReceipt>;
}

const unknownReceipt = (asset: OtaAsset): OtaUploadReceipt => ({
  channel: asset.channel, assetId: asset.id, status: "unknown", synced: false,
});

function resolveAuth(spec: OtaChannelSpec, ctx: OtaContext = {}): { baseUrl: string; token: string } | null {
  const env = ctx.env ?? process.env;
  const values = spec.auth.map((key) => env[key]?.trim() ?? "");
  if (values.some((value) => !value)) return null;
  return { baseUrl: values[0]!.replace(/\/$/, ""), token: values[1]! };
}

function mapStatus(raw: unknown): OtaReviewStatus {
  const value = String(raw ?? "").toLowerCase();
  if (["approved", "pass", "online", "通过"].includes(value)) return "approved";
  if (["rejected", "reject", "fail", "offline", "驳回", "拒绝"].includes(value)) return "rejected";
  if (["pending", "pending_review", "audit", "审核中", "待审核"].includes(value)) return "pending_review";
  return "unknown";
}

export function createOtaAdapter(channel: OtaChannel): OtaAdapter {
  const spec = OTA_SPECS[channel];
  const ready = (ctx: OtaContext = {}) => resolveAuth(spec, ctx) !== null;
  const preflight = (asset: OtaAsset): { ok: boolean; reasons: string[] } => {
    const parsed = OtaAssetSchema.safeParse(asset);
    if (!parsed.success) {
      return { ok: false, reasons: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "asset"}：${i.message}`) };
    }
    const reasons: string[] = [];
    const row = parsed.data;
    if (!spec.supportedKinds.includes(row.kind)) reasons.push(`${spec.label} 不支持素材类型 ${row.kind}`);
    if (row.kind !== "video" && row.bytes !== undefined && row.bytes > spec.limits.maxImageBytes) {
      reasons.push(`图片 ${(row.bytes / MB).toFixed(1)}MB 超上限 ${(spec.limits.maxImageBytes / MB).toFixed(0)}MB`);
    }
    if (row.kind === "video" && row.bytes !== undefined && row.bytes > spec.limits.maxVideoBytes) {
      reasons.push(`视频 ${(row.bytes / MB).toFixed(1)}MB 超上限 ${(spec.limits.maxVideoBytes / MB).toFixed(0)}MB`);
    }
    if (row.kind === "album" && row.order >= spec.limits.albumMaxItems) {
      reasons.push(`相册序位 ${row.order} 超上限 ${spec.limits.albumMaxItems}`);
    }
    return { ok: reasons.length === 0, reasons };
  };
  return {
    spec,
    ready,
    preflight,
    async upload(asset: OtaAsset, ctx: OtaContext = {}): Promise<OtaUploadReceipt> {
      const auth = resolveAuth(spec, ctx);
      const pre = preflight(asset);
      if (!pre.ok) return { ...unknownReceipt(asset), rejectReason: pre.reasons.join("；") };
      if (!auth) return unknownReceipt(asset);
      const fetchImpl = ctx.fetchImpl ?? fetch;
      const response = await fetchImpl(`${auth.baseUrl}/assets`, {
        method: "POST",
        headers: { authorization: `Bearer ${auth.token}`, "content-type": "application/json" },
        body: JSON.stringify(asset),
      });
      if (!response.ok) return { ...unknownReceipt(asset), rejectReason: `HTTP ${response.status}` };
      const body = await response.json().catch(() => ({})) as { asset_id?: string; status?: string };
      const status = mapStatus(body.status);
      return {
        channel, assetId: asset.id, status,
        platformAssetId: body.asset_id,
        evidenceUri: `ota-receipt://${channel}/${body.asset_id ?? asset.id}`,
        synced: status !== "unknown",
        verifiedAt: new Date().toISOString(),
      };
    },
    async probeReceipt(platformAssetId: string, ctx: OtaContext = {}): Promise<OtaUploadReceipt> {
      const auth = resolveAuth(spec, ctx);
      if (!auth) return { channel, assetId: platformAssetId, platformAssetId, status: "unknown", synced: false };
      const fetchImpl = ctx.fetchImpl ?? fetch;
      const response = await fetchImpl(`${auth.baseUrl}/assets/${encodeURIComponent(platformAssetId)}`, {
        headers: { authorization: `Bearer ${auth.token}` },
      });
      if (!response.ok) return { channel, assetId: platformAssetId, platformAssetId, status: "unknown", synced: false, rejectReason: `HTTP ${response.status}` };
      const body = await response.json().catch(() => ({})) as { status?: string; reason?: string };
      const status = mapStatus(body.status);
      return {
        channel, assetId: platformAssetId, platformAssetId, status,
        rejectReason: body.reason,
        synced: status === "approved" || status === "rejected",
        verifiedAt: new Date().toISOString(),
      };
    },
  };
}

export function createOtaAdapters(): OtaAdapter[] {
  return (Object.keys(OTA_SPECS) as OtaChannel[]).map((channel) => createOtaAdapter(channel));
}
