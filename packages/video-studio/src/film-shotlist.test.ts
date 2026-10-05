import { expect, it, vi } from "vitest";
import { applyFilmEnvironment, exportPreproductionFilm, inspectFilmRenderRedlineRejection, mapPreproductionFilm, preparePreproductionFilmCandidate, verifyOpeningCaption } from "./film-shotlist.js";
const metadata = () => ({ brief: { duration: 30, platform: "douyin", aspectRatio: "9:16", resolution: "1080p" },
  characterArchive: { id: "ceo", name: "出镜人物", authorization: { evidence: "asset://registered-person" } } });
const raw = () => ({ shot_id: "S01", duration: 30, prompt: "正式完整提示词".repeat(220), fields: { scene: "柜台玻璃与实木", action: "出镜人物点头介绍", character: "出镜人物",
  costume: "黑色套装", lighting: "左侧窗光", dialogue: "出镜人物|独白|从容|看看这台双屏机。|LIP_SYNC:YES" } });
const result = () => ({ success: true, stages: { productionEngine: { shots: [raw()] }, prdGeneration: { data: { projectDefinition: { projectName: "模型生成标题" } } } } });
const environment = () => ({ sceneBible: { spaceId: "frontdesk", space: { building: "本片设计酒店前台", orientation: "东侧落地窗" },
  materials: [{ item: "柜台", material: "实木" }, { item: "隔窗", material: "玻璃" }], practicalLights: [{ type: "窗光" }], traces: [], environmentProfile: { setting: "interior", condition: "maintained" } },
  hook: { type: "scene-shock", promise: "双屏机", payoffShotId: "S01", firstShotTemplate: { visual: "CEO在柜台介绍", line: "看看这台双屏机。", lineSec: 2 }, sfx: { kind: "impact", atSec: .1 } },
  shots: [{ shotId: "S01", sceneId: "frontdesk" }] });
it("正式生成物原样映射字段与口播；不编创意，绑定明确档案引用", () => {
  const input = result(), before = structuredClone(input), document = mapPreproductionFilm({ result: input, metadata: metadata(), projectId: "P1" });
  expect(input).toEqual(before); expect(document).toMatchObject({ durationSeconds: 30, aspect: "9:16", title: "模型生成标题" });
  expect(document.shots[0]).toMatchObject({ shotId: "S01", action: raw().fields.action, costume: "黑色套装", assetRef: "asset://registered-person",
    dialogue: [{ speaker: "出镜人物", text: "看看这台双屏机。" }], prompt: raw().prompt });
});
it("正式修订后的纯台词字段优先于历史block文本，唯一说话人来自原block", () => {
  const r: any = result();
  r.stages.productionEngine.shots[0].fields.dialogue = "本次正式修订台词。";
  r.stages.productionEngine.shots[0].dialogueBlocks = [{ speaker: "出镜人物", type: "monologue", emotion: "calm", line: "旧版本台词。" }];
  const before = structuredClone(r);
  const doc = mapPreproductionFilm({ result: r, metadata: metadata(), projectId: "P1" });
  expect(doc.shots[0]!.dialogue).toEqual([{ speaker: "出镜人物", text: "本次正式修订台词。", type: "monologue", emotion: "calm" }]);
  expect(r).toEqual(before);
  r.stages.productionEngine.shots[0].dialogueBlocks.push({ speaker: "未知第二人", line: "别的台词" });
  expect(() => mapPreproductionFilm({ result: r, metadata: metadata(), projectId: "P1" })).toThrow("唯一正式说话人");
});
it("原卡明确无人产品镜保持无人；全片主要人物不能丢失或换人", () => {
  const r: any = result(); r.stages.productionEngine.shots[0].duration = 15;
  const productShot = { ...raw(), shot_id: "S02", duration: 15, fields: { ...raw().fields, character: "无角色出场，不适用", dialogue: "" } };
  r.stages.productionEngine.shots.push(productShot);
  const doc = mapPreproductionFilm({ result: r, metadata: metadata(), projectId: "P1" });
  expect(doc.shots[1]!.character).toBe("无角色出场，不适用");
  expect(doc.shots[1]!.assetRef).toBeUndefined(); expect(doc.shots[0]!.assetRef).toBe("asset://registered-person");
  r.stages.productionEngine.shots[0].fields.character = "无角色出场，不适用";
  expect(() => mapPreproductionFilm({ result: r, metadata: metadata(), projectId: "P1" })).toThrow("全片没有明确主要人物");
});
it("明确无对白映射为空；所有受审台词仍须在实际口播预算内，不能靠G6批准豁免", () => {
  const r: any = result(); r.stages.productionEngine.shots[0].duration = 4;
  r.stages.productionEngine.shots[0].fields.dialogue = "出镜人物|独白|明朗|" + "字".repeat(12);
  const meta = metadata(); meta.brief.duration = 4;
  expect(() => mapPreproductionFilm({ result: r, metadata: meta, projectId: "P1" })).toThrow("DIALOGUE_DURATION_INVALID");
  r.stages.productionEngine.shots[0].fields.dialogue = "无对白";
  expect(mapPreproductionFilm({ result: r, metadata: meta, projectId: "P1" }).shots[0]!.dialogue).toEqual([]);
});
it.each(["failed", "short", "duration", "cast", "duplicate", "degraded"])("%s输入拒绝，不补造镜头/台词/时长", kind => {
  const r: any = result();
  if (kind === "failed") r.success = false;
  if (kind === "short") r.stages.productionEngine.shots[0].prompt = "短";
  if (kind === "duration") r.stages.productionEngine.shots[0].duration = 29;
  if (kind === "cast") r.stages.productionEngine.shots[0].fields.character = "另一人";
  if (kind === "duplicate") r.stages.productionEngine.shots.push(raw());
  if (kind === "degraded") r.stages.prdGeneration.degraded = true;
  expect(() => mapPreproductionFilm({ result: r, projectId: "P1", metadata: metadata() })).toThrow(/FILM_/);
});
it("环境补全保持动作/台词/时长/提示词冻结，禁止未知镜号或改写", () => {
  const doc = mapPreproductionFilm({ result: result(), projectId: "P1", metadata: metadata() });
  const enriched = applyFilmEnvironment(doc, environment(), "douyin");
  for (const key of ["action", "dialogue", "prompt", "duration", "character", "assetRef"]) expect(enriched.shots[0]![key]).toEqual(doc.shots[0]![key]);
  const changed: any = environment(); changed.shots[0].action = "另编动作";
  expect(() => applyFilmEnvironment(doc, changed, "douyin")).toThrow("SCOPE_CHANGED");
  changed.shots = [{ shotId: "NEW" }]; expect(() => applyFilmEnvironment(doc, changed, "douyin")).toThrow("SCOPE_CHANGED");
});
it("钩子不能另写不存在的口播或兑现镜", () => {
  const doc = mapPreproductionFilm({ result: result(), projectId: "P1", metadata: metadata() });
  const changed = environment(); changed.hook.firstShotTemplate.line = "另一句台词";
  expect(() => applyFilmEnvironment(doc, changed, "douyin")).toThrow("DIALOGUE_CHANGED");
  changed.hook.payoffShotId = "missing"; expect(() => applyFilmEnvironment(doc, changed, "douyin")).toThrow("ENVIRONMENT_INVALID");
});
it("真正调用正式模型补全，再把完整产物送G6/G7；拒绝不能导出", async () => {
  const reason = vi.fn(async (_prompt: string, _options?: unknown) => ({ success: true, data: environment(), content: JSON.stringify(environment()) }));
  const onApproval = vi.fn(async (_input: unknown) => ({ approved: true }));
  await exportPreproductionFilm({ result: result(), projectId: "P1", metadata: metadata(), llm: { reason }, onApproval });
  expect(reason).toHaveBeenCalledOnce(); expect(reason.mock.calls[0]?.[0]).toContain(raw().prompt);
  expect(onApproval.mock.calls.map(call => (call[0] as any).gate)).toEqual(["G6_PROMPT", "G7_FINAL"]);
  onApproval.mockResolvedValueOnce({ approved: false });
  await expect(exportPreproductionFilm({ result: result(), projectId: "P1", metadata: metadata(), llm: { reason }, onApproval })).rejects.toThrow("EXPORT_UNVERIFIED");
});
it("无对白首镜只复用实际片头旁挂计划，不新增口播；冒造字幕或时间窗拒绝", () => {
  const r: any = result(); r.stages.productionEngine.shots[0].fields.dialogue = "无对白";
  r.stages.productionEngine.shots[0].fields.subtitle_content = "看看这台双屏机。";
  const doc = mapPreproductionFilm({ result: r, projectId: "P1", metadata: metadata() });
  const generated = environment(); generated.hook.firstShotTemplate.lineSec = 3;
  const next = applyFilmEnvironment(doc, generated, "douyin");
  expect(next.shots[0]!.dialogue).toEqual([]); expect(verifyOpeningCaption(next)).toMatchObject({ shotId: "S01", text: "看看这台双屏机。", delivery: "sidecar-only", endSec: 3 });
  const changed = structuredClone(next); changed.openingCaption.text = "新编承诺";
  expect(() => verifyOpeningCaption(changed)).toThrow("CAPTION_CHANGED");
  changed.openingCaption = structuredClone(next.openingCaption); changed.openingCaption.endSec = 8;
  expect(() => verifyOpeningCaption(changed)).toThrow("CAPTION_CHANGED");
  generated.hook.firstShotTemplate.lineSec = 4;
  expect(() => applyFilmEnvironment(doc, generated, "douyin")).toThrow("TIMING_CHANGED");
});
it("正式补全位于原G7之前，不伪造总体success；批准后导出同一候选不重新模型生成", async () => {
  const production = { shots: [raw()], prompts: [raw()] }, prd = result().stages.prdGeneration.data;
  const confirmations = { prd: { approved: true, prd }, prompts: { approved: true } };
  const reason = vi.fn(async (_prompt: string) => ({ success: true, data: environment() })), onApproval = vi.fn(async () => ({ approved: true }));
  const candidate = await preparePreproductionFilmCandidate({ production, confirmations, projectId: "P1", metadata: metadata(), llm: { reason }, onApproval,
    factRejection: "真实事实门拒绝：不得重新填回无据的防滑脚垫" });
  expect(reason).toHaveBeenCalledOnce(); expect(onApproval).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ gate: "G6_PROMPT" }));
  expect(reason.mock.calls[0]![0]).toContain("真实事实门拒绝：不得重新填回无据的防滑脚垫");
  expect(reason.mock.calls[0]![0]).toContain("当前document是实际修订后的完整镜头设计");
  const complete: any = result(); complete.stages.productionEngine = { ...production, formalFilmCandidate: candidate };
  complete.confirmations = { ...confirmations, preproduction: { approved: true } };
  expect(await exportPreproductionFilm({ result: complete, projectId: "P1", metadata: metadata(), llm: { reason }, onApproval })).toEqual(candidate);
  expect(reason).toHaveBeenCalledOnce(); expect(onApproval).toHaveBeenCalledOnce();
  for (const key of ["action", "dialogue", "prompt", "assetRef", "photo", "duration", "title"]) {
    const changed = structuredClone(complete);
    if (key === "title") changed.stages.productionEngine.formalFilmCandidate.title = "替换标题";
    else changed.stages.productionEngine.formalFilmCandidate.shots[0][key] = "审核后替换";
    await expect(exportPreproductionFilm({ result: changed, projectId: "P1", metadata: metadata(), llm: { reason }, onApproval })).rejects.toThrow("EXPORT_CHANGED");
  }
  complete.stages.productionEngine.shots[0].fields.action = "改变源动作";
  await expect(exportPreproductionFilm({ result: complete, projectId: "P1", metadata: metadata(), llm: { reason }, onApproval })).rejects.toThrow("EXPORT_CHANGED");
  await expect(preparePreproductionFilmCandidate({ production, confirmations: { ...confirmations, prompts: { approved: false } }, projectId: "P1", metadata: metadata(), llm: { reason }, onApproval })).rejects.toThrow("CANDIDATE_UNVERIFIED");
});
it("对应本次台词的实际块保留逐段情绪和已有时间码，不合并丢失受审信息", () => {
  const r: any = result(); r.stages.productionEngine.shots[0].fields.dialogue = "看看这台双屏机。角度可以调。";
  r.stages.productionEngine.shots[0].dialogueBlocks = [
    { speaker: "出镜人物", text: "看看这台双屏机。", emotion: "明朗", startSec: 0, endSec: 3 },
    { speaker: "出镜人物", text: "角度可以调。", emotion: "自然", startSec: 3, endSec: 5 },
  ];
  expect(mapPreproductionFilm({ result: r, projectId: "P1", metadata: metadata() }).shots[0]!.dialogue).toEqual(r.stages.productionEngine.shots[0].dialogueBlocks);
});
it("正式预制在环境生成与G7之前拦真实红线，保留确定性回执，不冒充模型拒绝", async () => {
  const row: any = raw(); row.fields.props = "柜台上的可见屏幕";
  const production = { shots: [row], prompts: [row] }, prd = result().stages.prdGeneration.data;
  const reason = vi.fn(), onApproval = vi.fn(), onArtifact = vi.fn();
  await expect(preparePreproductionFilmCandidate({ production, confirmations: { prd: { approved: true, prd }, prompts: { approved: true } },
    projectId: "P1", metadata: metadata(), llm: { reason }, onApproval, onArtifact })).rejects.toMatchObject({
      code: "FILM_EXPORT_UNVERIFIED", verdict: { approved: false, via: "deterministic", reason: expect.stringContaining("screen-no-logo-negative") },
    });
  expect(reason).not.toHaveBeenCalled(); expect(onApproval).not.toHaveBeenCalled(); expect(onArtifact).toHaveBeenCalledOnce();
});
it("已成功冻结稿只能因重算真实红线恢复；改稿、事实资格变动或没有红线均拒绝", () => {
  const r: any = result(); r.stages.productionEngine.shots[0].fields.props = "柜台上的可见屏幕";
  const exported = mapPreproductionFilm({ result: r, metadata: metadata(), projectId: "P1" });
  const proof = { root: "source", ref: "facts.json", sha256: "a".repeat(64) }, ready = { ...structuredClone(exported), marketingFacts: proof };
  expect(inspectFilmRenderRedlineRejection(exported, ready, proof)).toContain("不是原G6/G7模型裁决");
  for (const key of ["action", "duration", "prompt"]) {
    const changed = structuredClone(ready); changed.shots[0]![key] = "改变";
    expect(() => inspectFilmRenderRedlineRejection(exported, changed, proof)).toThrow("RESUME_CHANGED");
  }
  expect(() => inspectFilmRenderRedlineRejection(exported, ready, { ...proof, sha256: "b".repeat(64) })).toThrow("RESUME_CHANGED");
  const clean = mapPreproductionFilm({ result: result(), metadata: metadata(), projectId: "P1" });
  expect(() => inspectFilmRenderRedlineRejection(clean, { ...clean, marketingFacts: proof }, proof)).toThrow("NOT_REJECTED");
});
