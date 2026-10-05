import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alignPrdDelivery, installVendorPrdBridge } from "./prd-bridge.js";
const draft = () => ({ productPositioning: { targetPlatform: "通用", aspectRatio: "16:9" },
  productionConstraints: { qualityThresholds: { visual: .8, audio: .75, narrative: .85, consistency: .75 } },
  deliveryStandard: { acceptanceCriteria: { visual: .75, audio: .8, narrative: .75, consistency: .7 }, fallbackPlan: { trigger: "0.75" } } });
function fixture() {
  const buildPrompt = vi.fn((_discovery: Record<string, any>, _creative?: Record<string, any>) => "原生成器prompt");
  const generator = { generate: vi.fn(async (_discovery: Record<string, any>) => draft()),
    generateMarkdown: vi.fn((prd: unknown) => JSON.stringify(prd)), agent2: { _buildPrompt: buildPrompt }, agent3: { _buildPrompt: buildPrompt } };
  const system = { prdGenerator: generator, _confirmPRD: vi.fn(async (_md: string, _prd: unknown) => ({ approved: true, reason: "reviewed" })) };
  return { buildPrompt, generator, system };
}
describe("PRD正式生成与审核衔接", () => {
  it("平台使用明确Brief，两套阈值取更严格值且降级线同源，不修改场景或台词", () => {
    const prd = { ...draft(), scenePlan: { scenes: [{ dialogue: "模型原话", duration: 30 }] } };
    alignPrdDelivery(prd, { brief: { platform: "douyin", aspectRatio: "9:16" } });
    expect(prd.productPositioning).toEqual({ targetPlatform: "douyin", aspectRatio: "9:16" });
    expect(prd.productionConstraints.qualityThresholds).toEqual({ visual: .8, audio: .8, narrative: .85, consistency: .75 });
    expect(prd.deliveryStandard.acceptanceCriteria).toEqual(prd.productionConstraints.qualityThresholds);
    expect(prd.deliveryStandard.fallbackPlan.trigger).toContain('"audio":0.8');
    expect(prd.scenePlan.scenes).toEqual([{ dialogue: "模型原话", duration: 30 }]);
  });
  it("原生成器收到完整原文，实际模型仍调用；第一次稿件由原流程G4审核", async () => {
    const f = fixture(), original = f.generator.generate;
    const restore = installVendorPrdBridge(f.system, { brief: { platform: "douyin" }, characterArchive: { id: "ceo", authorization: { evidence: "asset://registered" } } });
    const source = { upstreamFields: { _originalStoryText: "原始完整创作要求" } };
    const prd = await f.generator.generate(source);
    expect(original).toHaveBeenCalledWith({ ...source, _originalStoryText: "原始完整创作要求" });
    expect(source).not.toHaveProperty("_originalStoryText"); expect(f.system._confirmPRD).not.toHaveBeenCalled();
    expect(f.generator.agent3._buildPrompt({})).toContain("原生成器prompt");
    expect(f.generator.agent3._buildPrompt({})).toContain("正式制作输入");
    expect(f.generator.generateMarkdown(prd)).toContain("asset://registered"); restore();
    expect(f.generator.generate).toBe(original); expect(f.generator.agent3._buildPrompt).toBe(f.buildPrompt);
  });
  it("审核建议后重生成的完整稿须重新通过G4，拒绝不能交给下游", async () => {
    const f = fixture(); installVendorPrdBridge(f.system, { brief: { platform: "douyin" } });
    await f.generator.generate({}); f.system._confirmPRD.mockResolvedValueOnce({ approved: false, reason: "稿件仍有矛盾" });
    await expect(f.generator.generate({ userModifications: ["修改"] })).rejects.toThrow("重生成稿未通过G4");
    expect(f.system._confirmPRD).toHaveBeenCalledOnce();
    expect(f.system._confirmPRD).toHaveBeenCalledWith(expect.stringContaining("douyin"), expect.objectContaining({ productPositioning: expect.objectContaining({ targetPlatform: "douyin" }) }));
  });
  it("原生成器失败保持失败，关闭后晚到结果不能送审", async () => {
    const f = fixture(); let release!: (value: ReturnType<typeof draft>) => void;
    f.generator.generate.mockImplementationOnce(async () => new Promise(resolve => { release = resolve; }));
    const restore = installVendorPrdBridge(f.system, {}), running = f.generator.generate({});
    restore(); release(draft()); await expect(running).rejects.toThrow("PRD_BRIDGE_CLOSED");
    expect(f.system._confirmPRD).not.toHaveBeenCalled();
  });
  it("阈值不存在时拒绝，不生成任意默认数字", () => {
    const prd = draft(); (prd.productionConstraints.qualityThresholds as any).visual = undefined;
    (prd.deliveryStandard.acceptanceCriteria as any).visual = undefined;
    expect(() => alignPrdDelivery(prd, {})).toThrow("PRD_QUALITY_INVALID");
  });
  it("显式交付规格覆盖品类4K模板，评审过程句不伪装为约束，参考取实际模型输出", async () => {
    const f = fixture();
    f.generator.generate.mockResolvedValueOnce({ ...draft(), productPositioning: { resolution: "4K" },
      visualSpecification: { visualReferences: ["本次模型选取的参考"] }, referenceCases: { filmReferences: ["无关旧模板"] },
      productionConstraints: { ...draft().productionConstraints, technicalConstraints: ["原约束", "用户要求: 替换2.4"],
        businessConstraints: ["用户要求: 重新改写", "事实红线"] },
      deliveryStandard: { ...draft().deliveryStandard, outputFormat: { container: "MP4", videoCodec: "H.265" },
        deliverables: [{ item: "video_master", spec: "4K" }] } } as any);
    const restore = installVendorPrdBridge(f.system, { brief: { resolution: "1080p", aspectRatio: "9:16", frameRate: 30, videoCodec: "H.264" } });
    const prd = await f.generator.generate({ userModifications: ["替换2.4"] });
    expect(prd.deliveryStandard).toMatchObject({ deliverables: [{ item: "video_master", spec: "MP4 / H.264 / 1080p / 9:16 / 30fps" }] });
    expect(prd.productionConstraints).toMatchObject({ technicalConstraints: ["原约束"], businessConstraints: ["事实红线"] });
    expect((prd as any).referenceCases.filmReferences).toEqual(["本次模型选取的参考"]); restore();
  });
  it.each([true, false])("G4拒绝后同阶段一次真实模型修订，复审=%s；批准前不改原稿", async approved => {
    const f = fixture(), root = mkdtempSync(join(tmpdir(), "prd-correction-"));
    const original = { ...draft(), productPositioning: { targetDuration: 30 }, audienceProfile: { emotionTriggers: ["第50秒旧模板"] } };
    const candidate = structuredClone(original); candidate.audienceProfile.emotionTriggers = ["本片结尾复述实际信息"];
    const reason = vi.fn(async (_prompt: string, _options?: unknown) => ({ success: true, data: candidate }));
    f.system._confirmPRD.mockResolvedValueOnce({ approved: false, reason: "第50秒超出片长；修正未支持隐喻" })
      .mockResolvedValueOnce({ approved, reason: approved ? "实际复审通过" : "仍有未支持事实" });
    const confirm = f.system._confirmPRD;
    const restore = installVendorPrdBridge(f.system, { brief: { durationSec: 30 } }, undefined, { identity: { specs: { 屏幕: "双屏" } } },
      { llm: { reason }, workDir: root, projectId: "P1" });
    try {
      const verdict = await f.system._confirmPRD(JSON.stringify(original), original);
      expect(reason).toHaveBeenCalledOnce(); expect(reason.mock.calls[0]?.[0]).toContain("第50秒超出片长");
      expect(confirm).toHaveBeenCalledTimes(2); expect(verdict.approved).toBe(approved);
      expect(original.audienceProfile.emotionTriggers).toEqual(approved ? candidate.audienceProfile.emotionTriggers : ["第50秒旧模板"]);
      const scope = join(root, "prd-corrections", readdirSync(join(root, "prd-corrections"))[0]!);
      expect(JSON.parse(readFileSync(join(scope, "rejected.json"), "utf8")).prd.audienceProfile.emotionTriggers).toEqual(["第50秒旧模板"]);
      expect(JSON.parse(readFileSync(join(scope, "verdict.json"), "utf8")).approved).toBe(approved);
      restore(); expect(f.system._confirmPRD).toBe(confirm);
    } finally { restore(); rmSync(root, { recursive: true, force: true }); }
  });
});
