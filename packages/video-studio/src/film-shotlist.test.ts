import { expect, it, vi } from "vitest";
import { applyFilmEnvironment, exportPreproductionFilm, mapPreproductionFilm } from "./film-shotlist.js";
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
