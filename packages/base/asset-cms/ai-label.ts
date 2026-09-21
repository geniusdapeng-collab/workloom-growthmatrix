/**
 * asset-cms/ai-label —— AI 生成内容标识（B-28/B-29）
 *
 * 双通道标识（合规口径：显式可见 + 隐式可检出）：
 *  - 显式：成品角标（位置与最小高度比例可核验）；
 *  - 隐式：PNG tEXt 元数据 + 成片 ffmpeg metadata（模型编号/生成时间/清单版本）。
 * 本模块只产出确定性的清单与工具参数，实际写入由视觉工位（PNG）与后期链（ffmpeg）执行；
 * 清单 URI 落 `label_manifest_uri`，供审计与平台抽检复算。
 */

export interface AiLabelManifest {
  schema: "workloom.ai-label/v1";
  assetId: string;
  model: string;
  generatedAt: string;
  explicit: {
    text: string;
    position: "top-left" | "top-right" | "bottom-left" | "bottom-right";
    /** 角标最小高度占比（相对画面高度），防止缩到不可读 */
    minHeightRatio: number;
  };
  implicit: {
    pngTextChunks: Record<string, string>;
    ffmpegMetadata: Record<string, string>;
  };
}

export interface AiLabelInput {
  assetId: string;
  model: string;
  generatedAt?: string;
  explicitText?: string;
  position?: AiLabelManifest["explicit"]["position"];
  minHeightRatio?: number;
  /** 行业附加的隐式字段（如 shot_id / prd_id） */
  extraImplicit?: Record<string, string>;
}

export function manifestUri(assetId: string): string {
  return `ai-label://asset/${encodeURIComponent(assetId)}/manifest.json`;
}

export function buildAiLabelManifest(input: AiLabelInput): AiLabelManifest {
  if (!input.assetId.trim()) throw new Error("AI 标识清单缺 assetId");
  if (!input.model.trim()) throw new Error("AI 标识清单缺 model（生成模型编号）");
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const explicitText = input.explicitText?.trim() || "AI 生成";
  const minHeightRatio = input.minHeightRatio ?? 0.03;
  if (!(minHeightRatio > 0 && minHeightRatio <= 0.2)) {
    throw new Error(`角标最小高度占比非法：${minHeightRatio}（应在 (0,0.2]）`);
  }
  const baseImplicit: Record<string, string> = {
    "workloom:ai_generated": "true",
    "workloom:generator_model": input.model.trim(),
    "workloom:generated_at": generatedAt,
    "workloom:label_schema": "workloom.ai-label/v1",
    ...input.extraImplicit,
  };
  return {
    schema: "workloom.ai-label/v1",
    assetId: input.assetId.trim(),
    model: input.model.trim(),
    generatedAt,
    explicit: {
      text: explicitText,
      position: input.position ?? "bottom-right",
      minHeightRatio,
    },
    implicit: {
      pngTextChunks: { ...baseImplicit, "workloom:explicit_text": explicitText },
      ffmpegMetadata: { ...baseImplicit },
    },
  };
}

export function assertManifestValid(manifest: AiLabelManifest): void {
  if (manifest.schema !== "workloom.ai-label/v1") throw new Error(`未知 AI 标识清单版本：${manifest.schema}`);
  if (!manifest.assetId || !manifest.model) throw new Error("AI 标识清单缺 assetId/model");
  if (manifest.implicit.ffmpegMetadata["workloom:ai_generated"] !== "true") {
    throw new Error("隐式标识缺失：workloom:ai_generated != true");
  }
  if (manifest.explicit.minHeightRatio <= 0) throw new Error("显式角标高度占比必须 > 0");
}

/** ffmpeg 输出元数据参数（成片隐式标识；与显式角标叠加使用）。 */
export function ffmpegLabelArgs(manifest: AiLabelManifest): string[] {
  assertManifestValid(manifest);
  return Object.entries(manifest.implicit.ffmpegMetadata)
    .flatMap(([key, value]) => ["-metadata", `${key}=${value}`]);
}

/** PNG tEXt 写入指令（视觉工位按此写 chunk；键值均为 UTF-8 安全文本）。 */
export function pngTextChunkSpec(manifest: AiLabelManifest): Array<{ keyword: string; text: string }> {
  assertManifestValid(manifest);
  return Object.entries(manifest.implicit.pngTextChunks).map(([keyword, text]) => ({ keyword, text }));
}
