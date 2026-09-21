/**
 * publish-rpa/specs —— 平台规格注册表加载与发布前硬校验
 *
 * 背景：各平台尺寸/字数/话题/定时规则此前散落在适配器常量、技能文档与围栏里，
 * 发布前没有统一硬校验，越规格内容只能等平台驳回。本模块把规格收敛为受控注册表：
 *  - 注册表是数据（bundle 的 platformSpecs 槽位），带来源、复核日期与状态；
 *  - needs-review 条目只允许内部预览；对外发布须 requireVerified=true，否则报错；
 *  - 校验是纯函数：同一输入同一结论，可被 runner、发布专员与验收脚本复用。
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

export const PLATFORM_SPECS_VERSION = "workloom.platform-specs/v1";

const RatioSchema = z.string().regex(/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/);

const ImageSpecSchema = z.object({
  ratios: z.array(RatioSchema).default([]),
  recommendedPixels: z.string().min(1).optional(),
  minPixels: z.string().min(1).optional(),
  maxCount: z.number().int().positive().optional(),
  minCount: z.number().int().positive().optional(),
  bodyImageWidthPx: z.number().int().positive().optional(),
}).strict().default({ ratios: [] });

const VideoSpecSchema = z.object({
  ratio: RatioSchema.optional(),
  shortsRatio: RatioSchema.optional(),
  recommendedPixels: z.string().min(1).optional(),
  minSeconds: z.number().positive().optional(),
  maxSeconds: z.number().positive().optional(),
  safeArea: z.object({
    rightRailPx: z.number().int().nonnegative().optional(),
    bottomPx: z.number().int().nonnegative().optional(),
    topPx: z.number().int().nonnegative().optional(),
  }).strict().optional(),
}).strict().default({});

const CaptionSpecSchema = z.object({
  titleMaxChars: z.number().int().positive().optional(),
  bodyMaxChars: z.number().int().positive().optional(),
  maxTags: z.number().int().nonnegative().optional(),
  scheduleSupported: z.boolean().default(false),
  scheduleMinAheadMinutes: z.number().int().nonnegative().optional(),
}).strict().default({ scheduleSupported: false });

const CadenceSpecSchema = z.object({
  dailyCap: z.number().int().positive().optional(),
  recommendedPerDay: z.string().min(1).optional(),
}).strict().default({});

export const PlatformSpecSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),
  label: z.string().min(1).max(40),
  aliases: z.array(z.string().min(1).max(40)).default([]),
  channels: z.array(z.string().min(1).max(20)).min(1),
  image: ImageSpecSchema,
  video: VideoSpecSchema,
  caption: CaptionSpecSchema,
  cadence: CadenceSpecSchema,
  status: z.enum(["verified", "needs-review"]),
  source: z.string().min(1).max(300),
  verifiedAt: z.string().max(40).nullable().default(null),
  reviewDue: z.string().max(40).nullable().default(null),
}).strict();

export const PlatformSpecsSchema = z.object({
  schemaVersion: z.literal(PLATFORM_SPECS_VERSION),
  generatedAt: z.string().min(1).max(40),
  note: z.string().max(500).optional(),
  groups: z.record(z.string().min(1).max(40), z.array(z.string().min(1).max(60))).default({}),
  platforms: z.array(PlatformSpecSchema).min(1),
}).strict();

export type PlatformSpec = z.infer<typeof PlatformSpecSchema>;
export type PlatformSpecs = z.infer<typeof PlatformSpecsSchema>;

export class PlatformSpecsError extends Error {
  constructor(public readonly source: string, message: string) {
    super(`平台规格注册表无效（${source}）：${message}`);
    this.name = "PlatformSpecsError";
  }
}

export function parsePlatformSpecs(text: string, source = "<inline>"): PlatformSpecs {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new PlatformSpecsError(source, `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = PlatformSpecsSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new PlatformSpecsError(source, `${first?.path.join(".") ?? ""} ${first?.message ?? "结构不合法"}`);
  }
  const ids = new Set<string>();
  for (const platform of parsed.data.platforms) {
    if (ids.has(platform.id)) throw new PlatformSpecsError(source, `平台 id 重复：${platform.id}`);
    ids.add(platform.id);
  }
  for (const [group, members] of Object.entries(parsed.data.groups)) {
    for (const member of members) {
      if (!ids.has(member)) throw new PlatformSpecsError(source, `分组「${group}」引用了未登记平台：${member}`);
    }
  }
  return parsed.data;
}

export function loadPlatformSpecs(path: string): PlatformSpecs {
  if (!existsSync(path)) throw new PlatformSpecsError(path, "文件不存在");
  return parsePlatformSpecs(readFileSync(path, "utf-8"), path);
}

export type PlatformResolution =
  | { kind: "platform"; spec: PlatformSpec; matchedBy: "id" | "label" | "alias" }
  | { kind: "group"; group: string; members: string[] };

/** 解析平台名（id / 中文名 / 别名 / 分组名）；未登记返回 null */
export function resolvePlatform(specs: PlatformSpecs, name: string): PlatformResolution | null {
  const trimmed = name.trim();
  for (const spec of specs.platforms) {
    if (spec.id === trimmed) return { kind: "platform", spec, matchedBy: "id" };
    if (spec.label === trimmed) return { kind: "platform", spec, matchedBy: "label" };
    if (spec.aliases.includes(trimmed)) return { kind: "platform", spec, matchedBy: "alias" };
  }
  const group = specs.groups[trimmed];
  if (group) return { kind: "group", group: trimmed, members: group };
  return null;
}

export interface PublishSpecInput {
  platform: string;
  caption?: string;
  title?: string;
  tags?: readonly string[];
  scheduleAt?: string | Date | null;
  now?: Date;
  imageCount?: number;
  coverWidth?: number;
  coverHeight?: number;
  videoSeconds?: number;
}

export interface PublishSpecIssue {
  code: string;
  severity: "error" | "warn";
  detail: string;
}

export interface PublishSpecVerdict {
  ok: boolean;
  platformId: string | null;
  issues: PublishSpecIssue[];
}

function ratioValue(ratio: string): number | null {
  const [w, h] = ratio.split(":").map(Number);
  if (!w || !h || !Number.isFinite(w) || !Number.isFinite(h)) return null;
  return w / h;
}

function closestRatioIssue(spec: PlatformSpec, width: number, height: number): PublishSpecIssue | null {
  const allowed = [...spec.image.ratios, spec.video.ratio, spec.video.shortsRatio].filter((r): r is string => Boolean(r));
  if (allowed.length === 0) return null;
  const actual = width / height;
  const matched = allowed.some((ratio) => {
    const expected = ratioValue(ratio);
    return expected !== null && Math.abs(actual - expected) / expected <= 0.02;
  });
  return matched ? null : {
    code: "cover-ratio-mismatch",
    severity: "error",
    detail: `封面比例 ${width}x${height} 不在允许比例内：${allowed.join("、")}`,
  };
}

/**
 * 发布前规格校验。requireVerified=true 时 needs-review 平台直接报错（对外发布场景）；
 * 分组平台名只做「组内是否存在已登记平台」检查，不套用单一平台限额（由调用方按具体平台再校验）。
 */
export function validatePublishInput(
  specs: PlatformSpecs,
  input: PublishSpecInput,
  opts: { requireVerified?: boolean } = {},
): PublishSpecVerdict {
  const resolution = resolvePlatform(specs, input.platform);
  const issues: PublishSpecIssue[] = [];
  if (!resolution) {
    return {
      ok: false,
      platformId: null,
      issues: [{ code: "unknown-platform", severity: "error", detail: `未登记平台：${input.platform}` }],
    };
  }
  if (resolution.kind === "group") {
    if (resolution.members.length === 0) {
      issues.push({ code: "empty-platform-group", severity: "warn", detail: `分组「${resolution.group}」无成员，无法套用规格` });
    }
    return { ok: issues.every((issue) => issue.severity !== "error"), platformId: null, issues };
  }
  const spec = resolution.spec;
  if (spec.status === "needs-review") {
    issues.push({
      code: "platform-needs-review",
      severity: opts.requireVerified ? "error" : "warn",
      detail: `平台「${spec.label}」规格尚未官方复核（${spec.id}），仅允许内部预览`,
    });
  }
  const { caption, title, tags = [], scheduleAt, now, imageCount, coverWidth, coverHeight, videoSeconds } = input;
  if (title && spec.caption.titleMaxChars && title.length > spec.caption.titleMaxChars) {
    issues.push({ code: "title-too-long", severity: "error", detail: `标题 ${title.length} 字 > 上限 ${spec.caption.titleMaxChars} 字` });
  }
  if (caption && spec.caption.bodyMaxChars && caption.length > spec.caption.bodyMaxChars) {
    issues.push({ code: "caption-too-long", severity: "error", detail: `文案 ${caption.length} 字 > 上限 ${spec.caption.bodyMaxChars} 字` });
  }
  if (spec.caption.maxTags !== undefined && tags.length > spec.caption.maxTags) {
    issues.push({ code: "tags-exceed", severity: "error", detail: `话题 ${tags.length} 个 > 上限 ${spec.caption.maxTags} 个` });
  }
  if (scheduleAt) {
    if (!spec.caption.scheduleSupported) {
      issues.push({ code: "schedule-unsupported", severity: "error", detail: `平台「${spec.label}」不支持定时发布` });
    } else if (spec.caption.scheduleMinAheadMinutes) {
      const at = scheduleAt instanceof Date ? scheduleAt : new Date(scheduleAt);
      const base = now ?? new Date();
      const aheadMinutes = (at.getTime() - base.getTime()) / 60_000;
      if (!Number.isFinite(aheadMinutes) || aheadMinutes < spec.caption.scheduleMinAheadMinutes) {
        issues.push({
          code: "schedule-too-soon",
          severity: "error",
          detail: `定时需至少提前 ${spec.caption.scheduleMinAheadMinutes} 分钟（当前 ${Math.round(aheadMinutes)} 分钟）`,
        });
      }
    }
  }
  if (imageCount !== undefined && spec.image.maxCount !== undefined && imageCount > spec.image.maxCount) {
    issues.push({ code: "image-count-exceed", severity: "error", detail: `图片 ${imageCount} 张 > 上限 ${spec.image.maxCount} 张` });
  }
  if (imageCount !== undefined && spec.image.minCount !== undefined && imageCount < spec.image.minCount) {
    issues.push({ code: "image-count-below-min", severity: "error", detail: `图片 ${imageCount} 张 < 下限 ${spec.image.minCount} 张` });
  }
  if (coverWidth && coverHeight) {
    const ratioIssue = closestRatioIssue(spec, coverWidth, coverHeight);
    if (ratioIssue) issues.push(ratioIssue);
  }
  if (videoSeconds !== undefined) {
    if (spec.video.minSeconds !== undefined && videoSeconds < spec.video.minSeconds) {
      issues.push({ code: "video-too-short", severity: "error", detail: `视频 ${videoSeconds}s < 下限 ${spec.video.minSeconds}s` });
    }
    if (spec.video.maxSeconds !== undefined && videoSeconds > spec.video.maxSeconds) {
      issues.push({ code: "video-too-long", severity: "error", detail: `视频 ${videoSeconds}s > 上限 ${spec.video.maxSeconds}s` });
    }
  }
  return { ok: issues.every((issue) => issue.severity !== "error"), platformId: spec.id, issues };
}
