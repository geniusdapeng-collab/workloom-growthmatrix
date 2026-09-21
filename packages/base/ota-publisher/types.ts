/**
 * ota-publisher · 类型与契约（B-19）
 *
 * OTA 素材上传包：把「房型图 / 相册 / 视频」三类素材上传到携程/美团/飞猪商家后台，
 * 返回平台素材 ID 与审核状态；审核状态由回执探测回写。凭证只读环境变量，缺凭证 fail-closed。
 */
import { z } from "zod";

export const OtaChannelSchema = z.enum(["ctrip", "meituan", "fliggy"]);
export type OtaChannel = z.infer<typeof OtaChannelSchema>;

/** 三类素材（与 OTA 后台一致）：房型图 / 相册 / 视频 */
export const OtaAssetKindSchema = z.enum(["room_photo", "album", "video"]);
export type OtaAssetKind = z.infer<typeof OtaAssetKindSchema>;

export const OtaAssetSchema = z.object({
  id: z.string().min(1).max(120),
  channel: OtaChannelSchema,
  kind: OtaAssetKindSchema,
  propertyId: z.string().min(1).max(80),
  roomTypeId: z.string().min(1).max(80).optional(),
  /** 本地文件路径（上传由商家 API 完成，不落公网 URL） */
  filePath: z.string().min(1).max(500),
  caption: z.string().max(200).optional(),
  /** 相册排序位（0 起） */
  order: z.number().int().nonnegative().default(0),
  mimeType: z.string().max(100).optional(),
  bytes: z.number().int().positive().optional(),
}).strict();
export type OtaAsset = z.infer<typeof OtaAssetSchema>;

export const OtaReviewStatusSchema = z.enum(["pending_review", "approved", "rejected", "unknown"]);
export type OtaReviewStatus = z.infer<typeof OtaReviewStatusSchema>;

export const OtaUploadReceiptSchema = z.object({
  channel: OtaChannelSchema,
  assetId: z.string(),
  status: OtaReviewStatusSchema,
  platformAssetId: z.string().optional(),
  evidenceUri: z.string().optional(),
  rejectReason: z.string().optional(),
  /** 无平台确认一律 false（无回执=未核实） */
  synced: z.boolean(),
  verifiedAt: z.iso.datetime({ offset: true }).optional(),
}).strict();
export type OtaUploadReceipt = z.infer<typeof OtaUploadReceiptSchema>;

export interface OtaLimits {
  maxImageBytes: number;
  maxVideoBytes: number;
  maxVideoSeconds: number;
  albumMaxItems: number;
}

export interface OtaChannelSpec {
  channel: OtaChannel;
  label: string;
  /** [baseUrlKey, tokenKey, ...extraKey] */
  auth: readonly string[];
  supportedKinds: readonly OtaAssetKind[];
  limits: OtaLimits;
  docs: string;
}

export interface OtaContext {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}
