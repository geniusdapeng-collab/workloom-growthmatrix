/**
 * bundles/matrix —— 获客内容矩阵（内容类型 × 平台矩阵 × 投放目标）
 *
 * 定位：第一批交付的 123 个内容子类是本系统的作战底盘。此前它们只存在于文档，
 * 生产侧没有任何对象承载，导致「矩阵缺口」无法被机器发现。本模块把矩阵变成
 * 受控数据源：解析 → 结构校验 → 覆盖缺口报告（缺平台/缺目标/缺岗位/缺闸口）。
 *
 * 纪律：
 *  - 纯函数、零 DB 依赖；文件读取与业务判断分离，便于门禁脚本与单测复用；
 *  - 未命中引用（岗位/围栏/平台）如实报告，不猜测、不自动修复；
 *  - 矩阵是数据不是指令：解析结果只描述事实，执行仍走围栏与审批。
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import YAML from "yaml";

export const GROWTH_MATRIX_VERSION = "growth-matrix/v1";

/** 投放目标全集（T1 成交 / T2 询盘留资 / T3 关注 / T4 互动 / T5 私域 / T6 品牌信任 / T7 搜索可见 / T8 B 端渠道） */
export const MATRIX_TARGETS = ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8"] as const;
export type MatrixTarget = (typeof MATRIX_TARGETS)[number];

export const MatrixItemSchema = z.object({
  id: z.string().regex(/^[A-L]\d{1,2}$/),
  name: z.string().min(1).max(120),
  instance: z.string().max(300).default(""),
  purpose: z.string().max(300).default(""),
  platforms: z.array(z.string().min(1).max(60)).min(1),
  accountSlots: z.array(z.string().min(1).max(60)).default([]),
  targets: z.array(z.enum(MATRIX_TARGETS)).min(1),
  cta: z.string().max(200).default(""),
  cadence: z.string().max(120).default(""),
  production: z.string().max(120).default(""),
  owner: z.string().regex(/^[a-z][a-z0-9-]{1,79}$/),
  fences: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9-]*$/)).default([]),
  acceptance: z.string().max(300).default(""),
}).strict();

export const MatrixClassSchema = z.object({
  key: z.string().regex(/^[A-L]$/),
  label: z.string().min(1).max(60),
  items: z.array(MatrixItemSchema).min(1),
}).strict();

export const GrowthMatrixSchema = z.object({
  version: z.literal(GROWTH_MATRIX_VERSION),
  schema: z.literal(GROWTH_MATRIX_VERSION).optional(),
  classes: z.array(MatrixClassSchema).min(1),
}).strict();

export type MatrixItem = z.infer<typeof MatrixItemSchema>;
export type MatrixClass = z.infer<typeof MatrixClassSchema>;
export type GrowthMatrix = z.infer<typeof GrowthMatrixSchema>;

export class MatrixParseError extends Error {
  constructor(public readonly source: string, message: string) {
    super(`矩阵解析失败（${source}）：${message}`);
    this.name = "MatrixParseError";
  }
}

/** 解析矩阵 YAML 文本并做结构校验（失败即抛，不静默降级） */
export function parseGrowthMatrix(text: string, source = "<inline>"): GrowthMatrix {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (error) {
    throw new MatrixParseError(source, `YAML 语法错误：${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = GrowthMatrixSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new MatrixParseError(source, `${first?.path.join(".") ?? ""} ${first?.message ?? "结构不合法"}`);
  }
  const ids = new Set<string>();
  for (const klass of parsed.data.classes) {
    for (const item of klass.items) {
      if (ids.has(item.id)) throw new MatrixParseError(source, `条目编号重复：${item.id}`);
      ids.add(item.id);
      if (!item.id.startsWith(klass.key)) {
        throw new MatrixParseError(source, `条目 ${item.id} 与所属大类 ${klass.key} 不一致`);
      }
    }
  }
  return parsed.data;
}

/** 读取矩阵文件（不存在即抛，避免"空矩阵也算通过"） */
export function loadGrowthMatrix(path: string): GrowthMatrix {
  if (!existsSync(path)) throw new MatrixParseError(path, "文件不存在");
  return parseGrowthMatrix(readFileSync(path, "utf-8"), path);
}

export interface MatrixStats {
  classes: number;
  items: number;
  byPlatform: Record<string, number>;
  byTarget: Record<string, number>;
  byOwner: Record<string, number>;
}

export function matrixStats(matrix: GrowthMatrix): MatrixStats {
  const byPlatform: Record<string, number> = {};
  const byTarget: Record<string, number> = {};
  const byOwner: Record<string, number> = {};
  let items = 0;
  for (const klass of matrix.classes) {
    for (const item of klass.items) {
      items += 1;
      for (const platform of item.platforms) byPlatform[platform] = (byPlatform[platform] ?? 0) + 1;
      for (const target of item.targets) byTarget[target] = (byTarget[target] ?? 0) + 1;
      byOwner[item.owner] = (byOwner[item.owner] ?? 0) + 1;
    }
  }
  return { classes: matrix.classes.length, items, byPlatform, byTarget, byOwner };
}

export type MatrixGapKind =
  | "unknown-owner"
  | "unknown-fence"
  | "unknown-platform"
  | "target-missing"
  | "slot-missing";

export interface MatrixGap {
  kind: MatrixGapKind;
  itemId: string;
  detail: string;
}

export interface MatrixReferenceSet {
  /** 已在编岗位 preset_key 集合（未提供则不做岗位对账） */
  owners?: readonly string[];
  /** 围栏规则 id 集合（未提供则不做闸口对账） */
  fences?: readonly string[];
  /** 平台规格注册表可识别名称（id + label + aliases；未提供则不做平台对账） */
  platforms?: readonly string[];
}

/**
 * 缺口报告：把「引用不存在」如实列出。始终检查 target 与 accountSlots 完整性；
 * 引用集合缺省时跳过对应对账（调用方须在报告中声明跳过范围）。
 */
export function matrixGapReport(matrix: GrowthMatrix, refs: MatrixReferenceSet = {}): MatrixGap[] {
  const ownerSet = refs.owners ? new Set(refs.owners) : null;
  const fenceSet = refs.fences ? new Set(refs.fences) : null;
  const platformSet = refs.platforms ? new Set(refs.platforms) : null;
  const gaps: MatrixGap[] = [];
  for (const klass of matrix.classes) {
    for (const item of klass.items) {
      if (item.targets.length === 0) {
        gaps.push({ kind: "target-missing", itemId: item.id, detail: "未声明投放目标" });
      }
      if (item.accountSlots.length === 0) {
        gaps.push({ kind: "slot-missing", itemId: item.id, detail: "未声明账号位" });
      }
      if (ownerSet && !ownerSet.has(item.owner)) {
        gaps.push({ kind: "unknown-owner", itemId: item.id, detail: `岗位未在编：${item.owner}` });
      }
      if (fenceSet) {
        for (const fence of item.fences) {
          if (!fenceSet.has(fence)) {
            gaps.push({ kind: "unknown-fence", itemId: item.id, detail: `围栏未找到：${fence}` });
          }
        }
      }
      if (platformSet) {
        for (const platform of item.platforms) {
          if (!platformSet.has(platform)) {
            gaps.push({ kind: "unknown-platform", itemId: item.id, detail: `平台未登记：${platform}` });
          }
        }
      }
    }
  }
  return gaps;
}

export function formatMatrixGaps(gaps: readonly MatrixGap[]): string {
  if (gaps.length === 0) return "矩阵缺口：0 项";
  const byKind: Record<string, number> = {};
  for (const gap of gaps) byKind[gap.kind] = (byKind[gap.kind] ?? 0) + 1;
  const head = Object.entries(byKind).map(([kind, count]) => `${kind}=${count}`).join(" ");
  const detail = gaps.slice(0, 50).map((gap) => `- [${gap.kind}] ${gap.itemId}：${gap.detail}`).join("\n");
  return `矩阵缺口：${gaps.length} 项（${head}）\n${detail}${gaps.length > 50 ? `\n… 其余 ${gaps.length - 50} 项省略` : ""}`;
}
