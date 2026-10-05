import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPromptCorrection, installVendorPromptReviewBridge, readPromptCorrectionCheckpoint, type PromptReviewTarget } from "./prompt-review-bridge.js";
const metadata = { brief: { durationSec: 4 }, characterArchive: { id: "ceo", name: "出镜人物", persona: { speechRate: "3.2 字/秒" } } };
const original = () => [{ shotId: "S1", duration: 4, fields: { character: "出镜人物", action: "原动作", dialogue: "原话", audio: "原同期" },
  prompt: "原话".repeat(600), dialogueBlocks: [{ speaker: "出镜人物", text: "历史旧话" }] }];
const candidate = () => ({ shots: [{ shotId: "S1", duration: 4, fields: { character: "出镜人物", action: "修订动作", dialogue: "双屏可选。", audio: "同期人声" },
  prompt: "修订完整提示词".repeat(200), dialogueBlocks: [{ speaker: "出镜人物", type: "口播", emotion: "明朗", text: "双屏可选。" }] }] });
describe("原G6同阶段模型修订与消费绑定", () => {
  it("宿主复读的最终事实真实拒绝驱动模型修订，原G6只审核新稿，不复用原批准", async () => {
    const root = mkdtempSync(join(tmpdir(), "fact-prompt-repair-")), prompts = original();
    const confirm = vi.fn(async (_shots: unknown) => ({ approved: true })), reason = vi.fn(async (_prompt: string) => ({ success: true, data: candidate() }));
    const system = { create: vi.fn(async () => ({})), _confirmPrompts: confirm, _confirmPreproductionResult: vi.fn(async () => ({ approved: true })) };
    const restore = installVendorPromptReviewBridge(system, { metadata, llm: { reason }, projectId: "P1", workDir: root,
      initialRejection: { reason: "最终商品事实门实际拒绝：入住效果没有来源", candidate: { shots: original() } } });
    try {
      expect((await system._confirmPrompts(prompts)).approved).toBe(true);
      expect(reason).toHaveBeenCalledOnce(); expect(reason.mock.calls[0]?.[0]).toContain("入住效果没有来源");
      expect(confirm).toHaveBeenCalledExactlyOnceWith(expect.arrayContaining([expect.objectContaining({ action: "修订动作" })]));
      const scope = join(root, "prompt-corrections", readdirSync(join(root, "prompt-corrections"))[0]!);
      expect(JSON.parse(readFileSync(join(scope, "rejected.json"), "utf8")).verdict).toMatchObject({ approved: false });
    } finally { restore(); rmSync(root, { recursive: true, force: true }); }
  });
  it("新稿不携带旧增强层冲突副本，原运行标识保留且原稿可按摘要追溯", () => {
    const src: any = original(); src[0].title = "旧未支持效果"; src[0].characterDescs = "旧长裤";
    src[0].audioLayer = "旧镜内BGM"; src[0].sceneType = "opening";
    const c: any = candidate(); Object.assign(c.shots[0].fields, { title_content: "双屏自助机", subtitle_content: "登记型号",
      title_animation: "封面设计，视频母版不绘字", title_font_design: "封面中文清晰可读", opening_audio_design: "真实空间环境音，无镜内音乐" });
    const next = applyPromptCorrection(src, c, metadata)[0]!;
    expect(next).toMatchObject({ shotId: "S1", duration: 4, sceneType: "opening", action: "修订动作" });
    expect(next.title).toBeUndefined(); expect(next.characterDescs).toBeUndefined(); expect(next.audioLayer).toBeUndefined();
    expect(next.promptCorrectionSourceSha256).toMatch(/^[a-f0-9]{64}$/); expect(src[0].title).toBe("旧未支持效果");
  });
  it("审核报告保留实际稿，不替无人镜补面部或复制陈旧标题，关闭后还原", () => {
    const originalReport = vi.fn((_shots: unknown) => "旧报告增补面部描述和旧标题");
    const system = { create: vi.fn(async () => ({})), _confirmPrompts: vi.fn(async () => ({ approved: true })),
      _confirmPreproductionResult: vi.fn(async () => ({ approved: true })), _generatePromptsReport: originalReport };
    const restore = installVendorPromptReviewBridge(system, { metadata, llm: { reason: vi.fn() }, workDir: "/unused", projectId: "P1" });
    const shots = original(); const report = JSON.parse(system._generatePromptsReport(shots));
    expect(report.shots).toEqual(shots); expect(report.projectId).toBe("P1"); expect(originalReport).not.toHaveBeenCalled();
    restore(); expect(system._generatePromptsReport).toBe(originalReport);
  });
  it.each(["scope", "duration", "field", "speaker", "speech", "mismatch", "prompt"])("%s失配在复审/修改原稿前拒绝", kind => {
    const src = original(), before = structuredClone(src), c = candidate(), row = c.shots[0]!;
    if (kind === "scope") row.shotId = "OTHER";
    if (kind === "duration") row.duration = 9;
    if (kind === "field") delete (row.fields as any).action;
    if (kind === "speaker") row.dialogueBlocks[0]!.speaker = "未登记游客";
    if (kind === "speech") { row.dialogueBlocks[0]!.text = "字".repeat(30); row.fields.dialogue = row.dialogueBlocks[0]!.text; }
    if (kind === "mismatch") row.fields.dialogue = "与块不一致";
    if (kind === "prompt") row.prompt = "短";
    expect(() => applyPromptCorrection(src, c, metadata)).toThrow(); expect(src).toEqual(before);
  });
  it.each([true, false])("原G6复审=%s；只批准稿才进入实际G7/导出，拒绝与响应落盘", async approved => {
    const root = mkdtempSync(join(tmpdir(), "prompt-review-")), prompts = original();
    const review = vi.fn(async (_shots: unknown) => ({ approved: false, reason: "衣装冲突" }));
    review.mockResolvedValueOnce({ approved: false, reason: "衣装冲突" }).mockResolvedValueOnce({ approved, reason: "实际复审" });
    const final = vi.fn(async (_production: unknown) => ({ approved: true }));
    let system!: PromptReviewTarget;
    const production = { shots: original(), prompts };
    const create = vi.fn(async () => {
      const verdict = await system._confirmPrompts(prompts);
      if (verdict.approved) await system._confirmPreproductionResult(production);
      return { success: verdict.approved, stages: { productionEngine: { shots: original(), prompts: original() } } };
    });
    system = { create, _confirmPrompts: review, _confirmPreproductionResult: final };
    const reason = vi.fn(async () => ({ success: true, data: candidate() }));
    const restore = installVendorPromptReviewBridge(system, { metadata, llm: { reason }, projectId: "P1", workDir: root });
    try {
      const result = await system.create();
      expect(review).toHaveBeenCalledTimes(2); expect(reason).toHaveBeenCalledOnce();
      expect(final).toHaveBeenCalledTimes(approved ? 1 : 0);
      expect(result.stages.productionEngine.shots[0].dialogue).toBe(approved ? "双屏可选。" : undefined);
      expect(prompts[0]!.fields.action).toBe(approved ? "修订动作" : "原动作");
      const scope = join(root, "prompt-corrections", readdirSync(join(root, "prompt-corrections"))[0]!);
      expect(JSON.parse(readFileSync(join(scope, "verdict.json"), "utf8")).approved).toBe(approved);
      await system._confirmPrompts(prompts); expect(reason).toHaveBeenCalledOnce();
    } finally { restore(); expect(system.create).toBe(create); rmSync(root, { recursive: true, force: true }); }
  });
  it("关闭后晚到模型结果不能复审或修改原镜头", async () => {
    const root = mkdtempSync(join(tmpdir(), "prompt-close-")), shots = original(); let release!: (value: any) => void;
    const reason = vi.fn(async () => new Promise<any>(resolve => { release = resolve; }));
    const confirm = vi.fn(async (_shots: unknown) => ({ approved: false, reason: "冲突" }));
    const system = { create: vi.fn(async () => ({})), _confirmPrompts: confirm, _confirmPreproductionResult: vi.fn(async () => ({ approved: true })) };
    const restore = installVendorPromptReviewBridge(system, { metadata, llm: { reason }, workDir: root, projectId: "P1" });
    try {
      const pending = system._confirmPrompts(shots); while (!reason.mock.calls.length) await Promise.resolve();
      restore(); release({ success: true, data: candidate() }); await expect(pending).rejects.toThrow("作用域已关闭");
      expect(confirm).toHaveBeenCalledOnce(); expect(shots).toEqual(original());
    } finally { restore(); rmSync(root, { recursive: true, force: true }); }
  });
  it.each([true, false])("输出契约错误只反馈一次；第二稿合法=%s，原G6只审合法稿", async valid => {
    const root = mkdtempSync(join(tmpdir(), "prompt-contract-")), shots = original();
    const bad: any = candidate(); bad.shots[0].sceneType = "opening";
    const reason = vi.fn(async (_prompt: string) => ({ success: true, data: bad }));
    reason.mockResolvedValueOnce({ success: true, data: bad }).mockResolvedValueOnce({ success: true, data: valid ? candidate() : bad });
    const confirm = vi.fn(async (_shots: unknown) => ({ approved: false, reason: "原审查" }));
    confirm.mockResolvedValueOnce({ approved: false, reason: "原审查" }).mockResolvedValueOnce({ approved: true, reason: "原复审" });
    const system = { create: vi.fn(async () => ({})), _confirmPrompts: confirm, _confirmPreproductionResult: vi.fn(async () => ({ approved: true })) };
    const restore = installVendorPromptReviewBridge(system, { metadata, llm: { reason }, workDir: root, projectId: "P1" });
    try {
      if (valid) expect((await system._confirmPrompts(shots)).approved).toBe(true);
      else await expect(system._confirmPrompts(shots)).rejects.toThrow("PROMPT_CORRECTION_SCOPE_CHANGED:S1");
      expect(reason).toHaveBeenCalledTimes(2); expect(confirm).toHaveBeenCalledTimes(valid ? 2 : 1);
      expect(reason.mock.calls[1]?.[0]).toContain("上一次模型响应不满足确定性输出契约");
      expect(shots[0]!.fields.action).toBe(valid ? "修订动作" : "原动作");
    } finally { restore(); rmSync(root, { recursive: true, force: true }); }
  });
  it("已生成候选复读必须等于实际模型响应及原镜合同，重新原G6审核；篡改拒绝", async () => {
    const root = mkdtempSync(join(tmpdir(), "prompt-checkpoint-"));
    const source = original(), confirm = vi.fn(async (_shots: unknown) => ({ approved: false, reason: "第一次" }));
    confirm.mockResolvedValueOnce({ approved: false, reason: "第一次" }).mockResolvedValueOnce({ approved: true, reason: "原复审" });
    const system = { create: vi.fn(async () => ({})), _confirmPrompts: confirm, _confirmPreproductionResult: vi.fn(async () => ({ approved: true })) };
    let restore = installVendorPromptReviewBridge(system, { metadata, llm: { reason: vi.fn(async () => ({ success: true, data: candidate() })) }, workDir: root, projectId: "P1" });
    try {
      await system._confirmPrompts(source); restore();
      expect(readPromptCorrectionCheckpoint(root, "P1", original(), metadata)).toEqual(source);
      expect(readPromptCorrectionCheckpoint(root, "OTHER", original(), metadata)).toBeNull();
      const untouched = original(); untouched[0]!.fields.action = "另一个原稿";
      expect(readPromptCorrectionCheckpoint(root, "P1", untouched, metadata)).toBeNull();
      const reason = vi.fn(); confirm.mockClear(); confirm.mockResolvedValue({ approved: true, reason: "本次真实复审" });
      restore = installVendorPromptReviewBridge(system, { metadata, llm: { reason }, workDir: root, projectId: "P1", reuseGeneratedCandidate: true });
      const resumed = original(); await system._confirmPrompts(resumed);
      expect(confirm).toHaveBeenCalledOnce(); expect(reason).not.toHaveBeenCalled(); expect(resumed).toEqual(source);
      const file = join(root, "prompt-corrections", readdirSync(join(root, "prompt-corrections"))[0]!, "candidate.json");
      const altered = JSON.parse(readFileSync(file, "utf8")); altered[0].prompt += "篡改";
      const fs = await import("node:fs"); fs.writeFileSync(file, JSON.stringify(altered));
      expect(() => readPromptCorrectionCheckpoint(root, "P1", original(), metadata)).toThrow("CHECKPOINT_CHANGED");
    } finally { restore(); rmSync(root, { recursive: true, force: true }); }
  });
  it("G7报告保留完整镜头和剧本、真实旧裁决与复用资产，不输出截断计数；关闭还原", () => {
    const finalReport = vi.fn((_a: any, _b: any, _c: any, _d: any) => "旧角色数0及截断报告");
    const system = { create: vi.fn(async () => ({})), _confirmPrompts: vi.fn(async () => ({ approved: true })),
      _confirmPreproductionResult: vi.fn(async () => ({ approved: true })), _generatePreproductionReport: finalReport };
    const portraits = { characterId: "ceo", humanRecord: { via: "owner-acceptance" }, files: { front: "真实路径" } };
    const restore = installVendorPromptReviewBridge(system, { metadata, llm: { reason: vi.fn() }, workDir: "/unused", projectId: "P1", reusedPortraits: portraits });
    const production = { shots: original(), prompts: original() }, script = { blueprint: { scenes: ["完整剧本"], characters: ["出镜人物"] } };
    const oldConfirmations = { portraitGeneration: { approved: false, reason: "未新出图" } };
    try {
      const report = JSON.parse(system._generatePreproductionReport(production, script, { effective: 1200 }, oldConfirmations));
      expect(report.production.shots).toEqual(production.shots); expect(report.production.prompts).toBeUndefined();
      expect(report.script).toEqual(script); expect(report.reusedPortraits).toEqual(portraits);
      expect(report.confirmations.portraitGeneration).toMatchObject(oldConfirmations.portraitGeneration);
      expect(report.confirmations.portraitGeneration.sourceRecordSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(report.binding.identical).toBe(true); expect(finalReport).not.toHaveBeenCalled();
    } finally { restore(); expect(system._generatePreproductionReport).toBe(finalReport); }
  });
});
