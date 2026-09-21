/**
 * B-29 AI 标识清单测试：显式角标 + 隐式 PNG/ffmpeg 元数据，确定性且可校验。
 */
import { describe, expect, it } from "vitest";
import {
  assertManifestValid, buildAiLabelManifest, ffmpegLabelArgs, manifestUri, pngTextChunkSpec,
} from "./ai-label.js";

const input = {
  assetId: "va-1", model: "doubao-seedream-4.0",
  generatedAt: "2026-09-22T01:00:00.000Z", extraImplicit: { "workloom:project_id": "proj-1" },
};

describe("B-29 AI 标识清单", () => {
  it("清单结构：显式角标默认右下、高度占比 3%、隐式含模型与时间", () => {
    const m = buildAiLabelManifest(input);
    expect(m).toMatchObject({
      schema: "workloom.ai-label/v1",
      assetId: "va-1", model: "doubao-seedream-4.0", generatedAt: "2026-09-22T01:00:00.000Z",
      explicit: { text: "AI 生成", position: "bottom-right", minHeightRatio: 0.03 },
      implicit: { ffmpegMetadata: { "workloom:ai_generated": "true", "workloom:project_id": "proj-1" } },
    });
    expect(manifestUri("va-1")).toBe("ai-label://asset/va-1/manifest.json");
  });

  it("确定性：同输入同输出；缺 asset/model 或非法占比 → 抛错", () => {
    expect(buildAiLabelManifest(input)).toEqual(buildAiLabelManifest(input));
    expect(() => buildAiLabelManifest({ ...input, assetId: "" })).toThrow(/assetId/);
    expect(() => buildAiLabelManifest({ ...input, model: "" })).toThrow(/model/);
    expect(() => buildAiLabelManifest({ ...input, minHeightRatio: 0.5 })).toThrow(/角标/);
  });

  it("ffmpeg 参数与 PNG chunk 规格可直接下发；清单缺隐式标识被拒", () => {
    const m = buildAiLabelManifest(input);
    const args = ffmpegLabelArgs(m);
    expect(args).toContain("-metadata");
    expect(args.join(" ")).toContain("workloom:ai_generated=true");
    expect(args.join(" ")).toContain("workloom:generator_model=doubao-seedream-4.0");
    const chunks = pngTextChunkSpec(m);
    expect(chunks.find((c) => c.keyword === "workloom:ai_generated")?.text).toBe("true");
    expect(chunks.find((c) => c.keyword === "workloom:explicit_text")?.text).toBe("AI 生成");
    expect(() => assertManifestValid({ ...m, implicit: { ...m.implicit, ffmpegMetadata: {} } })).toThrow(/隐式标识缺失/);
  });
});
