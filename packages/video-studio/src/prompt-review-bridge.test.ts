import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPromptCorrection, installVendorPromptReviewBridge, readPromptCorrectionCheckpoint, readPromptCorrectionFailureFeedback, type PromptReviewTarget } from "./prompt-review-bridge.js";
const metadata = { brief: { durationSec: 4 }, characterArchive: { id: "ceo", name: "出镜人物", persona: { speechRate: "3.2 字/秒" } } };
const original = () => [{ shotId: "S1", duration: 4, fields: { character: "出镜人物", action: "原动作", dialogue: "原话", audio: "原同期" },
  prompt: "原话".repeat(600), dialogueBlocks: [{ speaker: "出镜人物", text: "历史旧话" }] }];
const candidate = () => ({ shots: [{ shotId: "S1", duration: 4, fields: { character: "出镜人物", action: "修订动作", dialogue: "双屏可选。", audio: "同期人声" },
  prompt: "修订完整提示词".repeat(200), dialogueBlocks: [{ speaker: "出镜人物", type: "口播", emotion: "明朗", text: "双屏可选。" }] }] });
describe("原G6同阶段模型修订与消费绑定", () => {
  it("外部JSON可重试失败使用原两次预算重生成完整稿，失败原文留证且只审合法新稿", async () => {
    const root = mkdtempSync(join(tmpdir(), "prompt-json-retry-")), prompts = original();
    const failed = { success: false, content: '{"shots":[{"prompt":"未闭合', retryable: true, error: "JSON 解析失败", usage: { completionTokens: 32771 } };
    const reason = vi.fn(async (_prompt: string, _options?: unknown): Promise<any> => ({ success: true, data: candidate() }));
    reason.mockResolvedValueOnce(failed);
    const confirm = vi.fn(async (_shots: unknown) => ({ approved: false, reason: "原真实拒绝" }));
    confirm.mockResolvedValueOnce({ approved: false, reason: "原真实拒绝" }).mockResolvedValueOnce({ approved: true, reason: "新稿实际复审" });
    const system = { create: vi.fn(async () => ({})), _confirmPrompts: confirm, _confirmPreproductionResult: vi.fn(async () => ({ approved: true })) };
    const restore = installVendorPromptReviewBridge(system, { metadata, llm: { reason }, projectId: "P1", workDir: root });
    try {
      expect((await system._confirmPrompts(prompts)).approved).toBe(true); expect(reason).toHaveBeenCalledTimes(2); expect(confirm).toHaveBeenCalledTimes(2);
      expect(reason.mock.calls[1]![0]).toContain("不返回局部修改或续写片段"); expect(prompts[0]!.fields.action).toBe("修订动作");
      const scope = join(root, "prompt-corrections", readdirSync(join(root, "prompt-corrections"))[0]!);
      expect(JSON.parse(readFileSync(join(scope, "model-response-1.json"), "utf8"))).toEqual(failed);
    } finally { restore(); rmSync(root, { recursive: true, force: true }); }
  });
  it.each([true, false])("外部修订最终失败retryable=%s保留真实原拒绝和准确尝试数，不丢裁决或改原稿", async retryable => {
    const root = mkdtempSync(join(tmpdir(), "prompt-model-failure-")), prompts = original();
    const reason = vi.fn(async () => ({ success: false, error: "真实模型失败", retryable }));
    const confirm = vi.fn(async (_shots: unknown) => ({ approved: false, reason: "原真实拒绝" }));
    const system = { create: vi.fn(async () => ({})), _confirmPrompts: confirm, _confirmPreproductionResult: vi.fn(async () => ({ approved: true })) };
    const restore = installVendorPromptReviewBridge(system, { metadata, llm: { reason }, projectId: "P1", workDir: root });
    try {
      const verdict = await system._confirmPrompts(prompts); expect(verdict.approved).toBe(false); expect(verdict.reason).toContain("原真实拒绝");
      expect(reason).toHaveBeenCalledTimes(retryable ? 2 : 1); expect(confirm).toHaveBeenCalledOnce(); expect(prompts).toEqual(original());
      const scope = join(root, "prompt-corrections", readdirSync(join(root, "prompt-corrections"))[0]!);
      expect(JSON.parse(readFileSync(join(scope, "repair-failure.json"), "utf8"))).toMatchObject({ verdict, attempts: retryable ? 2 : 1 });
    } finally { restore(); rmSync(root, { recursive: true, force: true }); }
  });
  it("单镜不过长但全片口播不足/过多时，按制作合同拒绝且保留原稿", () => {
    const src = original(), before = structuredClone(src), response = candidate();
    const brief = { ...metadata, brief: { dialogueRequirement: "总计约5至8汉字，留呼吸" } };
    expect(() => applyPromptCorrection(src, response, brief)).toThrow("PROMPT_DIALOGUE_TOTAL_INVALID:实际4字");
    response.shots[0]!.fields.dialogue = "双屏可选模式。";
    response.shots[0]!.dialogueBlocks[0]!.text = response.shots[0]!.fields.dialogue;
    expect(applyPromptCorrection(src, response, brief)[0]!.dialogueText).toBe("双屏可选模式。");
    expect(() => applyPromptCorrection(src, response, { ...metadata, brief: { dialogueRequirement: "3–5字" } })).toThrow("PROMPT_DIALOGUE_TOTAL_INVALID:实际6字");
    expect(() => applyPromptCorrection(src, response, { ...metadata, brief: { dialogueRequirement: "8至5汉字" } })).toThrow("PROMPT_DIALOGUE_RANGE_INVALID");
    expect(src).toEqual(before);
  });
  it("G6报告只去重逐值相同别名，保留冲突值与完整prompt，绑定未改原稿", () => {
    const shots: any = original(), source = shots[0];
    source.action = source.fields.action; source.audio = "独有的冲突声音";
    source.fields.camera_movement = "原运镜"; source.cameraMovement = "原运镜"; source.camera_movement = "不同运镜";
    const before = structuredClone(shots);
    const system = { create: vi.fn(async () => ({})), _confirmPrompts: vi.fn(async () => ({ approved: true })),
      _confirmPreproductionResult: vi.fn(async () => ({ approved: true })), _generatePromptsReport: vi.fn((_shots: unknown) => "旧报告") };
    const restore = installVendorPromptReviewBridge(system, { metadata, llm: { reason: vi.fn() }, workDir: "/unused", projectId: "P1" });
    try {
      const report = JSON.parse(system._generatePromptsReport(shots)), row = report.shots[0];
      expect(row.action).toBeUndefined(); expect(row.cameraMovement).toBeUndefined();
      expect(row.audio).toBe("独有的冲突声音"); expect(row.camera_movement).toBe("不同运镜");
      expect(row.fields).toEqual(source.fields); expect(row.prompt).toBe(source.prompt);
      expect(report.sourceShotsSha256).toMatch(/^[a-f0-9]{64}$/); expect(shots).toEqual(before);
      expect(report.contract.fields).toContain("只有原sceneType=opening");
    } finally { restore(); }
  });
  it("模型修稿必须真正补齐渲染红线，不能靠原模型批准豁免或宿主改词", () => {
    const src: any = original(), response: any = candidate();
    src[0].fields.props = "可见屏幕"; response.shots[0].fields.props = "可见屏幕";
    expect(() => applyPromptCorrection(src, response, metadata)).toThrow("PROMPT_RENDER_REDLINE_REJECTED");
    response.shots[0].fields.props = "可见屏幕，界面虚化不可辨认";
    src[0].fields.negative = "旧负面"; response.shots[0].fields.negative = "无界面文字、无屏幕可读文字、无图标、无LOGO";
    expect(applyPromptCorrection(src, response, metadata)[0]!.props).toContain("界面虚化不可辨认");
    expect(src[0].fields.props).toBe("可见屏幕");
  });
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
  it("最终事实修订后环境失败可复读同合同同理由的实际新稿，重新G6审核；理由或合同改变不能复用", async () => {
    const root = mkdtempSync(join(tmpdir(), "final-contract-checkpoint-"));
    const initialRejection = { reason: "确定性实际拒绝：台式机类别未验证", candidate: { shots: original(), sceneBible: { id: "原合同" } } };
    const confirm = vi.fn(async (_shots: unknown) => ({ approved: true, reason: "本次真实复审" }));
    const reason = vi.fn(async () => ({ success: true, data: candidate() }));
    const system = { create: vi.fn(async () => ({})), _confirmPrompts: confirm, _confirmPreproductionResult: vi.fn(async () => ({ approved: true })) };
    let restore = installVendorPromptReviewBridge(system, { metadata, llm: { reason }, workDir: root, projectId: "P1", initialRejection });
    try {
      const repaired = original(); await system._confirmPrompts(repaired); restore();
      const actual = { verdict: { approved: false, reason: initialRejection.reason }, candidate: initialRejection.candidate };
      expect(readPromptCorrectionCheckpoint(root, "P1", original(), metadata, actual)).toEqual(repaired);
      expect(readPromptCorrectionCheckpoint(root, "P1", original(), metadata, { ...actual, verdict: { approved: false, reason: "不同拒绝" } })).toBeNull();
      expect(readPromptCorrectionCheckpoint(root, "P1", original(), metadata, { ...actual, candidate: { shots: original(), sceneBible: { id: "改变合同" } } })).toBeNull();
      reason.mockClear(); confirm.mockClear();
      restore = installVendorPromptReviewBridge(system, { metadata, llm: { reason }, workDir: root, projectId: "P1", initialRejection });
      const resumed = original(); expect((await system._confirmPrompts(resumed)).approved).toBe(true);
      expect(reason).not.toHaveBeenCalled(); expect(confirm).toHaveBeenCalledExactlyOnceWith(repaired); expect(resumed).toEqual(repaired);
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
      else {
        const verdict = await system._confirmPrompts(shots);
        expect(verdict).toMatchObject({ approved: false });
        expect(verdict.reason).toContain("原审查");
        expect(verdict.reason).toContain("PROMPT_CORRECTION_SCOPE_CHANGED:S1");
        const scope = join(root, "prompt-corrections", readdirSync(join(root, "prompt-corrections"))[0]!);
        expect(JSON.parse(readFileSync(join(scope, "repair-failure.json"), "utf8"))).toMatchObject({
          verdict: { approved: false, reason: verdict.reason }, attempts: 2,
        });
      }
      expect(reason).toHaveBeenCalledTimes(2); expect(confirm).toHaveBeenCalledTimes(valid ? 2 : 1);
      expect(reason.mock.calls[1]?.[0]).toContain("上一次模型响应不满足确定性输出契约");
      expect(shots[0]!.fields.action).toBe(valid ? "修订动作" : "原动作");
    } finally { restore(); rmSync(root, { recursive: true, force: true }); }
  });
  it("不同镜头的合同错误一起反馈，整稿拒绝且没有部分修改", () => {
    const src = original(); src.push({ ...structuredClone(src[0]!), shotId: "S2" });
    const response = candidate(); response.shots.push({ ...structuredClone(response.shots[0]!), shotId: "S2" });
    response.shots[0]!.duration = 7;
    response.shots[1]!.dialogueBlocks[0]!.text = "字".repeat(30);
    response.shots[1]!.fields.dialogue = response.shots[1]!.dialogueBlocks[0]!.text;
    const before = structuredClone(src);
    expect(() => applyPromptCorrection(src, response, metadata)).toThrow(/PROMPT_CORRECTION_SCOPE_CHANGED:S1.*PROMPT_DIALOGUE_DURATION_INVALID:S2/);
    expect(src).toEqual(before);
  });
  it("恢复反馈重算同一原稿的实际失败，不能跨项目、换稿或篡改错误", async () => {
    const root = mkdtempSync(join(tmpdir(), "prompt-failure-resume-")), shots = original();
    const bad = candidate(); bad.shots[0]!.duration = 9;
    const confirm = vi.fn(async (_shots: unknown) => ({ approved: false, reason: "producer-rejected(G6)" }));
    const system = { create: vi.fn(async () => ({})), _confirmPrompts: confirm, _confirmPreproductionResult: vi.fn(async () => ({ approved: true })) };
    let restore = installVendorPromptReviewBridge(system, { metadata, llm: { reason: vi.fn(async () => ({ success: true, data: bad })) }, workDir: root, projectId: "P1" });
    try {
      expect((await system._confirmPrompts(shots)).approved).toBe(false); restore();
      expect(readPromptCorrectionFailureFeedback(root, "P1", shots, metadata)).toContain("PROMPT_CORRECTION_SCOPE_CHANGED:S1");
      expect(readPromptCorrectionFailureFeedback(root, "OTHER", shots, metadata)).toBe("");
      const changed = original(); changed[0]!.fields.action = "另一个原稿";
      expect(readPromptCorrectionFailureFeedback(root, "P1", changed, metadata)).toBe("");
      const reason = vi.fn(async (_prompt: string) => ({ success: true, data: candidate() }));
      confirm.mockResolvedValueOnce({ approved: false, reason: "producer-rejected(G6)" }).mockResolvedValueOnce({ approved: true, reason: "原G6实际复审" });
      restore = installVendorPromptReviewBridge(system, { metadata, llm: { reason }, workDir: root, projectId: "P1", reuseGeneratedCandidate: true });
      expect((await system._confirmPrompts(shots)).approved).toBe(true);
      expect(reason.mock.calls[0]?.[0]).toContain("上一次真实模型修订的合同错误已重新计算");
      restore();
      const scope = readdirSync(join(root, "prompt-corrections")).map(name => join(root, "prompt-corrections", name))
        .find(dir => { try { return JSON.parse(readFileSync(join(dir, "contract-failure-2.json"), "utf8")).error; } catch { return false; } })!;
      writeFileSync(join(scope, "contract-failure-2.json"), JSON.stringify({ error: "伪造错误" }));
      expect(() => readPromptCorrectionFailureFeedback(root, "P1", original(), metadata)).toThrow("CHECKPOINT_CHANGED");
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
