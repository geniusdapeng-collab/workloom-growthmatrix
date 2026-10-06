/** CLI接线回归：真实来源/摘要/审核适配器，LLM响应与创意引擎为明确测试替身；不提交渲染。 */
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ configs: [] as any[], inputs: [] as any[], results: [] as any[], rejectG1: false, rejectFinal: false }));
vi.mock("../../../../packages/video-studio/src/index.js", async importOriginal => {
  const original = await importOriginal<any>();
  return { ...original, installVendorEngineBridge: () => () => undefined,
    VideoStudio: class {
      constructor(config: unknown) { fixture.configs.push(config); }
      async runPreproduction(input: unknown) { fixture.inputs.push(input); return structuredClone(fixture.results.shift()); }
    } };
});
vi.mock("./data-mining-executor.js", async importOriginal => ({
  ...await importOriginal<any>(), createWebSearch: () => async () => [],
}));

let root: string, argv: string[], exitCode: typeof process.exitCode;
const cliEntry = new URL("../../../../scripts/tools/data-pipeline-run.mts", import.meta.url).href;
const successful = () => ({ success: true, stages: { productionEngine: { shots: [{ shot_id: "S1", duration: 30,
  prompt: "展示台式双屏自助机DEMO-T001可调节角度摄像头。", fields: { 商品型号: "DEMO-T001" } }] } } });
const rejected = () => ({ success: false, stages: {}, confirmations: { theme: { approved: false, reason: "producer-rejected" } } });
beforeEach(async () => {
  vi.resetModules(); fixture.configs = []; fixture.inputs = []; fixture.results = [successful()]; fixture.rejectG1 = false; fixture.rejectFinal = false;
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
    } else {
      const content = JSON.stringify(message);
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
  await import(cliEntry);
}
describe("营销CLI复用正式事实与G1", () => {
  it("完整G1通过后才构造VideoStudio，保存最终镜头事实资格且不提交渲染", async () => {
    await run();
    expect(fixture.configs).toHaveLength(1); expect(fixture.configs[0].deferRender).toBe(true);
    expect(fixture.configs[0].dataMining.verifiedRaw.projectId).toBe("CLI-P1");
    const result = JSON.parse(await readFile(path.join(root, "result.json"), "utf8"));
    expect(result.success).toBe(true); expect(result.producerAttempts).toBe(1);
    expect(result.marketingFacts.scope).toMatchObject({ projectId: "CLI-P1", tenantId: "cli-local", workspaceId: "cli-local", attempt: 1 });
    const facts = JSON.parse(await readFile(path.join(result.marketingFacts.root, result.marketingFacts.ref), "utf8"));
    expect(facts.outputReviews).toHaveLength(1);
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
