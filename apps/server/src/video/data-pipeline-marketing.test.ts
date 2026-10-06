/** CLI接线回归：真实来源/摘要/审核适配器，LLM响应与创意引擎为明确测试替身；不提交渲染。 */
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ configs: [] as any[], inputs: [] as any[], results: [] as any[], rejectG1: false, rejectFinal: false, transportFinal: false, prepareCandidate: false }));
vi.mock("../../../../packages/video-studio/src/index.js", async importOriginal => {
  const original = await importOriginal<any>();
  return { ...original, installVendorEngineBridge: () => () => undefined,
    VideoStudio: class {
      constructor(private config: any) { fixture.configs.push(config); }
      async runPreproduction(input: unknown) {
        fixture.inputs.push(input); const result = structuredClone(fixture.results.shift());
        if (fixture.prepareCandidate) {
          result.stages.dataMining = { data: JSON.parse(this.config.dataMining.verifiedDossier.assemblyJson) };
          const production = result.stages.productionEngine; production.prompts = structuredClone(production.shots);
          production.formalFilmCandidate = await this.config.prepareFilmCandidate(production, {}, {}, result.confirmations);
        }
        return result;
      }
    } };
});
vi.mock("./data-mining-executor.js", async importOriginal => ({
  ...await importOriginal<any>(), createWebSearch: () => async () => [],
}));

let root: string, argv: string[], exitCode: typeof process.exitCode;
const cliEntry = new URL("../../../../scripts/tools/data-pipeline-run.mts", import.meta.url).href;
const successful = () => ({ success: true, stages: { productionEngine: { shots: [{ shot_id: "S1", duration: 30,
  prompt: "展示台式双屏自助机DEMO-T001可调节角度摄像头。".repeat(60), fields: { 商品型号: "DEMO-T001", scene: "现代酒店柜台",
    action: "出镜人物指向摄像头", character: "出镜人物", dialogue: "出镜人物|独白|从容|看看这台双屏机。|LIP_SYNC:YES" } }] } } });
const rejected = () => ({ success: false, stages: {}, confirmations: { theme: { approved: false, reason: "producer-rejected" } } });
beforeEach(async () => {
  vi.resetModules(); fixture.configs = []; fixture.inputs = []; fixture.results = [successful()]; fixture.rejectG1 = false; fixture.rejectFinal = false; fixture.transportFinal = false; fixture.prepareCandidate = false;
  root = await realpath(await mkdtemp(path.join(tmpdir(), "data-pipeline-cli-")));
  argv = process.argv; exitCode = process.exitCode;
  vi.stubEnv("LLM_BASE_URL", "https://judge.example.test"); vi.stubEnv("LLM_API_KEY", "test-only"); vi.stubEnv("LLM_MODEL", "test-judge");
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(process, "exit").mockImplementation((code) => { throw new Error(`exit:${code}`); });
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const request = JSON.parse(String(init!.body)), message = request.messages.at(-1).content;
    let result: unknown;
    if (typeof message === "string" && message.includes("当前阶段：A1")) {
      const source = JSON.parse(/当前阶段：A1\n(.*)$/s.exec(message)![1]!).sources[0];
      result = { payload: { identity: { name: "台式双屏自助机", model: "DEMO-T001", specs: { 摄像头: "角度可调节" } }, images: [] },
        citations: ["/identity/name", "/identity/model", "/identity/specs/摄像头"].map(pointer => ({ pointer, sourceId: source.sourceId, quote: source.text })) };
    } else if (typeof message === "string" && message.includes("正式成片导出工位")) {
      result = { sceneBible: { spaceId: "frontdesk", space: { building: "本片设计酒店前台", orientation: "东侧窗" },
        materials: [{ item: "柜台", material: "实木" }, { item: "隔窗", material: "玻璃" }], practicalLights: [{ type: "窗光" }],
        traces: [], environmentProfile: { setting: "interior", condition: "maintained" } },
        hook: { type: "scene-shock", promise: "双屏机", payoffShotId: "S1", firstShotTemplate: { visual: "CEO在柜台介绍", line: "看看这台双屏机。", lineSec: 2 }, sfx: { kind: "impact", atSec: .1 } },
        shots: [{ shotId: "S1", sceneId: "frontdesk" }] };
    } else {
      const content = JSON.stringify(message);
      if (fixture.transportFinal && content.includes("marketing-final-fact-review")) throw new Error("The operation was aborted due to timeout");
      const approved = !(fixture.rejectG1 && content.includes("G1_DOSSIER") || fixture.rejectFinal && content.includes("marketing-final-fact-review"));
      result = { approved, score: approved ? 96 : 10, issues: approved ? [] : ["测试：事实不支持"], suggestions: [], reason: approved ? "测试：逐项支持" : "测试：事实不支持" };
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
  }));
});
afterEach(async () => {
  process.argv = argv; process.exitCode = exitCode; vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});
async function run(extra: string[] = []) {
  process.argv = [process.execPath, "data-pipeline-run.mts", "--intent", "为DEMO-T001制作30秒宣传片", "--route", "marketing",
    "--product", "示例品牌 台式双屏自助机", "--model", "DEMO-T001", "--product-archive", "demo-t001",
    "--project", "CLI-P1", "--out", root, "--work-dir", path.join(root, "runtime"), "--keys-file", path.join(root, "no-secret-file"),
    "--no-portraits", ...extra];
  try { await import(cliEntry); }
  catch (error) {
    let failure: { error: string };
    try { failure = JSON.parse(await readFile(path.join(root, "failure.json"), "utf8")); }
    catch (readError) { if ((readError as NodeJS.ErrnoException).code === "ENOENT") throw error; throw readError; }
    throw new Error(`${error instanceof Error ? error.message : String(error)}: ${failure.error}`);
  }
}
describe("营销CLI复用正式事实与G1", () => {
  it.each(["recover", "changed-prd", "rendered"])("最终事实传输%s：复用真实完整预制，只恢复外部审核，不再构造创作引擎", async state => {
    const complete: any = successful(); complete.stages.prdGeneration = { data: {} };
    complete.confirmations = { creativeTheme: { approved: true }, requirementList: { approved: true }, prd: { approved: true, prd: {} },
      prompts: { approved: true }, preproduction: { approved: true } };
    fixture.results = [complete]; fixture.prepareCandidate = true; fixture.transportFinal = true;
    await expect(run()).rejects.toThrow("exit:4");
    const source = root, previous = JSON.parse(await readFile(path.join(source, "preproduction-result.json"), "utf8"));
    if (state === "changed-prd") previous.stages.prdGeneration.data = { changed: true };
    if (state === "rendered") previous.stages.renderingEngine = { submitted: true };
    await writeFile(path.join(source, "preproduction-result.json"), JSON.stringify(previous));
    fixture.transportFinal = false; vi.resetModules(); root = path.join(source, "resumed");
    try {
      if (state === "recover") {
        await run(["--resume-preproduction", source]);
        const current = JSON.parse(await readFile(path.join(root, "result.json"), "utf8"));
        expect(current.success).toBe(true); expect(current.stages.productionEngine).toEqual(previous.stages.productionEngine);
        expect(JSON.parse(await readFile(path.join(root, "final-facts-resume.json"), "utf8")).reason).toContain("timeout");
        expect(JSON.parse(await readFile(path.join(root, "meta.json"), "utf8")).renderSubmitted).toBe(false);
      } else await expect(run(["--resume-preproduction", source])).rejects.toThrow("RESUME_UNVERIFIED");
      expect(fixture.configs).toHaveLength(1); expect(fixture.inputs).toHaveLength(1);
    } finally { root = source; }
  });
  it.each(["actual-redline", "changed-ready", "changed-proof", "not-rejected"])("成功预制恢复%s：仅真实冻结红线可进入修订工位", async state => {
    const first: any = successful();
    if (state !== "not-rejected") first.stages.productionEngine.shots[0].fields.props = "柜台上可见屏幕";
    fixture.results = [first]; await run();
    const source = root, previous = JSON.parse(await readFile(path.join(source, "result.json"), "utf8"));
    const ready = JSON.parse(await readFile(path.join(source, "film-shotlist.json"), "utf8"));
    const candidate = structuredClone(ready); delete candidate.marketingFacts;
    previous.stages.prdGeneration = { data: {} };
    previous.stages.productionEngine.formalFilmCandidate = candidate;
    previous.confirmations = { prd: { approved: true, prd: {} }, prompts: { approved: true }, preproduction: { approved: true } };
    // 此测试使用明确创作替身；受审完整环境由第一轮真实导出器生成并摘要绑定。
    candidate.exportProvenance.environmentReview = { approved: true };
    previous.stages.productionEngine.formalFilmCandidate = candidate;
    ready.exportProvenance.environmentReview = { approved: true };
    if (state === "changed-ready") ready.shots[0].action = "审核后改变动作";
    if (state === "changed-proof") previous.marketingFacts.sha256 = "0".repeat(64);
    await writeFile(path.join(source, "result.json"), JSON.stringify(previous));
    await writeFile(path.join(source, "film-shotlist.json"), JSON.stringify(ready));
    vi.resetModules(); root = path.join(source, "resumed"); fixture.results = [successful()];
    try {
      if (state === "actual-redline") {
        await run(["--resume-preproduction", source]);
        expect(fixture.configs).toHaveLength(2);
        expect(fixture.configs[1].finalFactRejection.reason).toContain("正式渲染前确定性红线实际拒绝");
        expect(fixture.inputs[1].resume.result.success).toBe(true);
      } else {
        await expect(run(["--resume-preproduction", source])).rejects.toThrow("exit:4");
        expect(fixture.configs).toHaveLength(1);
      }
    } finally { root = source; }
  });
  it.each(["tenantId", "workspaceId"])("恢复%s不同在构造创作工位前拒绝，不能按旧scope偷渡", async key => {
    await run(); const source = root, previous = JSON.parse(await readFile(path.join(source, "meta.json"), "utf8"));
    previous.marketingSource.scope[key] = "foreign";
    await writeFile(path.join(source, "meta.json"), JSON.stringify(previous));
    vi.resetModules(); root = path.join(source, "resumed");
    try {
      await expect(run(["--resume-preproduction", source])).rejects.toThrow("RESUME_SCOPE_CHANGED");
      expect(fixture.configs).toHaveLength(1);
    } finally { root = source; }
  });
  it("完整G1通过后才构造VideoStudio，保存最终镜头事实资格且不提交渲染", async () => {
    await run();
    expect(fixture.configs).toHaveLength(1); expect(fixture.configs[0].deferRender).toBe(true);
    expect(fixture.configs[0].dataMining.verifiedRaw.projectId).toBe("CLI-P1");
    expect(fixture.configs[0].dataMining.verifiedDossier.projectId).toBe("CLI-P1");
    expect(JSON.parse(fixture.configs[0].dataMining.verifiedDossier.assemblyJson).chain.ok).toBe(true);
    const result = JSON.parse(await readFile(path.join(root, "result.json"), "utf8"));
    expect(result.success).toBe(true); expect(result.producerAttempts).toBe(1);
    expect(result.marketingFacts.scope).toMatchObject({ projectId: "CLI-P1", tenantId: "cli-local", workspaceId: "cli-local", attempt: 1 });
    const facts = JSON.parse(await readFile(path.join(result.marketingFacts.root, result.marketingFacts.ref), "utf8"));
    expect(facts.outputReviews).toHaveLength(1);
    expect(facts.outputSceneBible.spaceId).toBe("frontdesk");
    expect(facts.sources[0].archive.originalReopened).toBe(false);
    expect(JSON.parse(await readFile(path.join(root, "meta.json"), "utf8")).renderSubmitted).toBe(false);
    expect(process.exitCode).toBe(0);
  });
  it.each(["review", "auto"])("%s模式不能绕过真实营销G1", async mode => {
    fixture.rejectG1 = true;
    await expect(run(["--producer", mode])).rejects.toThrow("exit:4");
    expect(fixture.configs).toHaveLength(0);
    expect(JSON.parse(await readFile(path.join(root, "failure.json"), "utf8")).error).toContain("MARKETING_G1_UNVERIFIED");
  });
  it("最终镜头事实被拒绝时不写成功结果，失败回执明确未渲染", async () => {
    fixture.rejectFinal = true;
    await expect(run()).rejects.toThrow("exit:4");
    await expect(readFile(path.join(root, "result.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(path.join(root, "failure.json"), "utf8"))).toMatchObject({ success: false, renderSubmitted: false });
  });
  it("默认打回即停，业务失败退出4，不自动重复预生产", async () => {
    fixture.results = [rejected(), successful()]; await run();
    expect(fixture.configs).toHaveLength(1); expect(process.exitCode).toBe(4);
    expect(JSON.parse(await readFile(path.join(root, "result.json"), "utf8"))).toMatchObject({ success: false, producerAttempts: 1 });
  });
  it("显式重试仍用新attempt重新取得事实/G1，不能复用旧批准", async () => {
    fixture.results = [rejected(), successful()]; await run(["--producer-retry", "1"]);
    expect(fixture.configs).toHaveLength(2);
    expect(fixture.configs[0].dataMining.storeRoot).not.toBe(fixture.configs[1].dataMining.storeRoot);
    expect(JSON.parse(await readFile(path.join(root, "result.json"), "utf8")).marketingFacts.scope.attempt).toBe(2);
  });
  it("metadata-file保留角色与引用，但请求篡改商品档案在任何创作之前拒绝", async () => {
    const metadata = path.join(root, "metadata.json");
    await writeFile(metadata, JSON.stringify({ characterArchive: { id: "demo-character" }, referenceManifest: { registered: true },
      productArchive: { id: "demo-t001", specs: { features: ["零秒入住"] } } }));
    // CLI显式id优先于metadata档案；此测试直接保留篡改对象，让正式宿主核对。
    const extra = ["--metadata-file", metadata];
    process.argv = [process.execPath, "data-pipeline-run.mts", "--intent", "介绍DEMO-T001", "--route", "marketing", "--product", "示例品牌 台式双屏自助机",
      "--out", root, "--work-dir", path.join(root, "runtime"), "--keys-file", path.join(root, "no-secret-file"), "--no-portraits", ...extra];
    await expect(import(cliEntry)).rejects.toThrow("exit:4");
    expect(fixture.configs).toHaveLength(0);
    expect(JSON.parse(await readFile(path.join(root, "failure.json"), "utf8")).error).toContain("MARKETING_ARCHIVE_CHANGED");
  });
});
