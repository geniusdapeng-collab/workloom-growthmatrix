import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPromptCorrection, installVendorPromptReviewBridge, type PromptReviewTarget } from "./prompt-review-bridge.js";
const metadata = { brief: { durationSec: 4 }, characterArchive: { id: "ceo", name: "出镜人物", persona: { speechRate: "3.2 字/秒" } } };
const original = () => [{ shotId: "S1", duration: 4, fields: { character: "出镜人物", action: "原动作", dialogue: "原话", audio: "原同期" },
  prompt: "原话".repeat(600), dialogueBlocks: [{ speaker: "出镜人物", text: "历史旧话" }] }];
const candidate = () => ({ shots: [{ shotId: "S1", duration: 4, fields: { character: "出镜人物", action: "修订动作", dialogue: "双屏可选。", audio: "同期人声" },
  prompt: "修订完整提示词".repeat(200), dialogueBlocks: [{ speaker: "出镜人物", type: "口播", emotion: "明朗", text: "双屏可选。" }] }] });
describe("原G6同阶段模型修订与消费绑定", () => {
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
});
