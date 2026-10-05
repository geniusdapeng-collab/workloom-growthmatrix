/** 实际来源HTTP、A1–A5 vendor装订、reviewStage及文件摘要；只有模型回答是HTTP协议替身。 */
import { createServer, type Server } from "node:http";
import { mkdtemp, realpath, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareMarketingFacts, authorizeMarketingFacts, finalizeMarketingFacts, verifyMarketingFacts, restoreReviewedMarketingFacts, restoreMarketingOutputRejection, type PreparedMarketingFacts } from "./marketing-authority.js";
import { fetchMarketingSource, requestSource } from "./marketing-source-fetcher.js";
import { canonicalRenderJson, renderSha256 } from "./gen/compiled-request.js";
const scope = { tenantId: "tenant-a", workspaceId: "ws-a", projectId: "P1", runId: "RUN1", attempt: 1 };
const env = { LLM_BASE_URL: "https://judge.example.test", LLM_API_KEY: "test-only", LLM_MODEL: "test-judge" };
const sourceUrl = "https://source.example.com/f3";
const sourceText = "星野 F3 是一款风扇，风量 9 档。尾部注意：9 档是风量档位，不是能耗等级；不得声称静音或市场第一。";
let server: Server, origin: string, root: string, modelCalls: any[], rejectJudge: boolean, extractionCalls: string[];
beforeAll(async () => {
  server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }); res.end(sourceText); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "marketing-authority-"))); modelCalls = []; extractionCalls = []; rejectJudge = false;
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => { modelCalls.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ approved: !rejectJudge, score: rejectJudge ? 10 : 96, issues: rejectJudge ? ["来源不支持此主张"] : [], suggestions: [], reason: rejectJudge ? "原文限定相冲突" : "逐项原文支持" }) } }] })); }));
});
afterEach(async () => { vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });
async function prepare(options: { noSearch?: boolean; noAux?: boolean; badQuote?: boolean; modelFailure?: boolean; fetchFailure?: boolean; mode?: string; attempt?: number; usage?: unknown } = {}): Promise<PreparedMarketingFacts> {
  let searches = 0;
  return prepareMarketingFacts({ scope: { ...scope, attempt: options.attempt ?? 1 }, root, intent: "做一条风扇介绍", metadata: { brief: { product: "星野 F3", brand: "星野" }, ...(options.usage === undefined ? {} : { marketingUsage: options.usage }) }, env: { ...env, ...(options.mode ? { VM_DATA_MINING_MODE: options.mode } : {}) },
    llm: { reason: async prompt => {
      extractionCalls.push(prompt); if (options.modelFailure) return { success: false, error: "LLM unavailable" };
      const match = /当前阶段：(A[123])\n(.*)$/s.exec(prompt)!; const source = JSON.parse(match[2]!).sources[0];
      if (match[1] !== "A1") return { success: true, data: { payload: match[1] === "A2" ? { reviews: [] } : { competitors: [] }, citations: [], noEvidenceReason: "页面仅商品规格，无可核实评价或竞品" } };
      return { success: true, data: { payload: { identity: { name: "星野 F3", specs: { 风量: "9 档" }, official_selling_points: [{ point: "风量 9 档", source_url: sourceUrl }] }, images: [] }, citations: ["/identity/name", "/identity/specs/风量", "/identity/official_selling_points/0/point"].map(pointer => ({ pointer, sourceId: source.sourceId, quote: options.badQuote ? "不存在的事实" : sourceText })) } };
    } }, dependencies: {
      search: async () => (++searches, options.noSearch || options.noAux && searches > 20 ? [] : [{ title: "星野规格", url: sourceUrl, snippet: "故意错误摘要999档，不能当事实" }]),
      fetchSource: async url => {
        if (options.fetchFailure) throw new Error("SOURCE_HTTP_FAILED：来源HTTP 403");
        return fetchMarketingSource(url, { resolver: async () => [{ address: "93.184.216.34", family: 4 }], transport: async (_url, _address, signal) => requestSource(new URL(origin), { address: "127.0.0.1", family: 4 }, signal) });
      },
    } });
}
const shots = [{ shotId: "S1", prompt: "窗边展示星野 F3 风扇，字幕说明风量 9 档。", fields: { 场景: "窗边", 产品: "星野 F3", 规格: "9 档" } }];
describe("营销事实宿主完整执行", () => {
  it("禁用规格不进入宣传档案或宣称上限，原始事实与引文继续保存", async () => {
    const prepared = await prepare({ usage: { forbiddenTerms: ["9 档"] } });
    expect((prepared.bundle.dossier.identity as any).specs).toEqual({});
    expect((prepared.bundle.cards.prd_card as any).compliance_redlines).toContain("宣传禁用：9 档");
    expect(prepared.raw.A1.identity).toMatchObject({ specs: { 风量: { value: "9 档" } } });
    expect(prepared.bundle.stages[0]!.facts.claims.some(claim => claim.value === "9 档")).toBe(true);
  });
  it("用途限制只收窄宣传，真实五站完整执行；无竞品不虚构差异化，空图片交接如实", async () => {
    const prepared = await prepare({ usage: { forbiddenTerms: ["风量 9 档"] } });
    expect(prepared.raw.A1.identity).toHaveProperty("official_selling_points");
    expect(prepared.bundle.stages[0]!.facts.claims.some(claim => claim.value === "风量 9 档")).toBe(true);
    expect((prepared.bundle.dossier.identity as any).official_selling_points).toEqual([]);
    expect(prepared.bundle.dossier.differentiation).toEqual({ our_opening: [], crowded_points: [], weakness_openings: [] });
    expect(prepared.bundle.assembly).toMatchObject({ ok: true, chain: { ok: true } });
    expect(prepared.bundle.assembly!.envelopes).toHaveLength(5);
    expect((prepared.bundle.cards.portrait_manifest as any).handoff_note).toContain("没有图像");
    const saved = JSON.parse(await readFile(path.join(prepared.storeRoot, String(prepared.bundle.assembly!.product_id), "dossier.json"), "utf8"));
    expect(saved).toEqual(prepared.bundle.dossier);
  });
  it.each([{ forbiddenTerms: [""] }, { forbiddenTerms: "不是数组" }, { approved: true }])("无效使用政策不能获得档案：%j", async usage => {
    await expect(prepare({ usage })).rejects.toThrow("MARKETING_USAGE_INVALID");
  });
  it("真实HTTP正文→三站提取/完整支持审核→A1–A5→逐最终镜头事实审核→复读", async () => {
    const prepared = await prepare();
    expect(prepared.bundle.stages.map(stage => [stage.stage, stage.facts.status])).toEqual([["A1", "source_bound"], ["A2", "no_evidence"], ["A3", "no_evidence"]]);
    expect(prepared.bundle.sources).toHaveLength(1); expect(prepared.bundle.restrictions).toHaveLength(2); expect(extractionCalls).toHaveLength(3);
    expect(prepared.g1Content).toContain('"schemaVersion":"workloom.marketing-facts/v1"'); expect(modelCalls).toHaveLength(3);
    expect(JSON.stringify(modelCalls)).toContain("不得声称静音或市场第一"); expect(JSON.stringify(modelCalls)).not.toContain("999档");
    const saved = await finalizeMarketingFacts(prepared, shots, env); expect(modelCalls).toHaveLength(4);
    const checked = await verifyMarketingFacts({ root, ...saved, scope, shots }); expect(checked.outputReviews[0]?.promptSha256).toBe(renderSha256(shots[0]!.prompt));
    expect(await readFile(path.join(root, checked.sources[0]!.textRef), "utf8")).toBe(sourceText);
  });
  it.each(["spec", "no-search", "bad-quote", "model-failure", "support-rejected"])("%s不能得到可送G1的事实包", async kind => {
    rejectJudge = kind === "support-rejected";
    await expect(prepare({ mode: kind === "spec" ? "spec" : undefined, noSearch: kind === "no-search", badQuote: kind === "bad-quote", modelFailure: kind === "model-failure" })).rejects.toThrow();
    if (["spec", "no-search", "bad-quote", "model-failure"].includes(kind)) expect(modelCalls).toHaveLength(0);
  });
  it("最终镜头夸大主张被监制拒绝，事实包不能完成", async () => {
    const prepared = await prepare(); rejectJudge = true;
    await expect(finalizeMarketingFacts(prepared, [{ ...shots[0]!, prompt: "全市场第一，零噪音" }], env)).rejects.toThrow("MARKETING_PROMPT_FACTS_REJECTED");
    await expect(readFile(path.join(root, `${prepared.prefix}-facts.json`))).rejects.toMatchObject({ code: "ENOENT" });
    const rejected = JSON.parse(await readFile(path.join(root, `${prepared.prefix}-shot-1.verdict.json`), "utf8"));
    expect(rejected).toMatchObject({ scope, shotId: "S1", verdict: { approved: false, status: "failed", score: 10 } });
  });
  it("最终事实真实拒绝可复读反馈；新输出审核单独落盘，旧失败不覆盖也不复用批准", async () => {
    const prepared = await prepare(); rejectJudge = true;
    await expect(finalizeMarketingFacts(prepared, shots, env)).rejects.toThrow("PROMPT_FACTS_REJECTED");
    const rejected = await restoreMarketingOutputRejection(prepared, shots);
    expect(rejected).toMatchObject({ shotId: "S1", verdict: { approved: false, via: "llm", status: "failed" } });
    const oldReceipt = await readFile(path.join(root, `${prepared.prefix}-shot-1.verdict.json`), "utf8");
    rejectJudge = false; const outputId = "RUN-11111111-1111-4111-8111-111111111111";
    const saved = await finalizeMarketingFacts(prepared, shots, env, outputId);
    expect(saved.ref).toBe(`${prepared.prefix}-output-${outputId}-facts.json`);
    expect((await verifyMarketingFacts({ root, ...saved, scope, shots })).outputReviews).toHaveLength(1);
    expect(await readFile(path.join(root, `${prepared.prefix}-shot-1.verdict.json`), "utf8")).toBe(oldReceipt);
    await expect(restoreMarketingOutputRejection(prepared, shots, outputId)).rejects.toThrow("REJECTION_REQUIRED");
  });
  it.each(["shot", "fields", "scope", "hash", "approval", "mock"])("输出拒绝%s变化不能取得同阶段修订资格", async kind => {
    const prepared = await prepare(); rejectJudge = true;
    await expect(finalizeMarketingFacts(prepared, shots, env)).rejects.toThrow("PROMPT_FACTS_REJECTED");
    const file = path.join(root, `${prepared.prefix}-shot-1.verdict.json`), receipt = JSON.parse(await readFile(file, "utf8"));
    const current = structuredClone(shots);
    if (kind === "shot") current[0]!.prompt += "变化";
    if (kind === "fields") current[0]!.fields.规格 = "99档";
    if (kind === "scope") receipt.scope.workspaceId = "other";
    if (kind === "hash") receipt.contentSha256 = "0".repeat(64);
    if (kind === "approval") receipt.verdict.approved = true;
    if (kind === "mock") receipt.verdict.via = "fallback";
    await writeFile(file, JSON.stringify(receipt));
    await expect(restoreMarketingOutputRejection(prepared, current)).rejects.toThrow();
  });
  it.each(["../escape", "", "RUN-not-uuid"])("输出标识%s不能逃离档案或冒充新执行", async outputId => {
    if (!outputId) outputId = "RUN-../";
    const prepared = await prepare();
    await expect(finalizeMarketingFacts(prepared, shots, env, outputId)).rejects.toThrow("OUTPUT_SCOPE_INVALID");
  });
  it("原文支持被拒绝时仍保存完整评分、问题和裁决，不能制造事实包", async () => {
    rejectJudge = true;
    await expect(prepare()).rejects.toThrow("MARKETING_SUPPORT_REJECTED");
    const rejected = JSON.parse(await readFile(path.join(root, "stages/preproduction/attempt-1.marketing-A1.verdict.json"), "utf8"));
    expect(rejected).toMatchObject({ scope, verdict: { approved: false, status: "failed", score: 10,
      issues: ["来源不支持此主张"] } });
    expect(rejected.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(readFile(path.join(root, "stages/preproduction/attempt-1.marketing-facts.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["raw", "text", "review", "prompt", "fields", "scope", "attempt", "expired", "claim-offset"])("%s变化不能复用营销事实资格", async kind => {
    const prepared = await prepare(), saved = await finalizeMarketingFacts(prepared, shots, env); let hash = saved.sha256;
    const requestedShots = structuredClone(shots), expectedScope = { ...scope };
    if (["raw", "text", "review"].includes(kind)) {
      const source = prepared.bundle.sources[0]!, file = kind === "raw" ? source.rawRef : kind === "text" ? source.textRef : prepared.bundle.stages[0]!.review!.ref;
      await writeFile(path.join(root, file), "changed");
    }
    if (kind === "prompt") requestedShots[0]!.prompt += "未审主张";
    if (kind === "fields") requestedShots[0]!.fields.规格 = "99 档";
    if (kind === "scope") expectedScope.tenantId = "other";
    if (kind === "attempt") expectedScope.attempt = 2;
    if (kind === "expired" || kind === "claim-offset") {
      if (kind === "expired") prepared.bundle.collectedAt = new Date(Date.now() - 25 * 3600_000).toISOString();
      else prepared.bundle.stages[0]!.facts.claims[0]!.quoteStart++;
      const text = canonicalRenderJson(prepared.bundle); await writeFile(path.join(root, saved.ref), text); hash = renderSha256(text);
    }
    await expect(verifyMarketingFacts({ root, ref: saved.ref, sha256: hash, scope: expectedScope, shots: requestedShots })).rejects.toThrow();
  });
  it("重复attempt写盘失败必须终止，不能当抓源失败换候选", async () => {
    await prepare(); await expect(prepare()).rejects.toMatchObject({ code: "EEXIST" });
  });
  it("引文失败前保存完整模型提取回包，不能只留下解析异常", async () => {
    await expect(prepare({ badQuote: true })).rejects.toThrow("MARKETING_CITATION_INVALID");
    const saved = JSON.parse(await readFile(path.join(root, "stages/preproduction/attempt-1.marketing-A1.extraction.json"), "utf8"));
    expect(saved.scope).toEqual(scope);
    expect(saved.content).toBeNull();
    expect(saved.data.citations).toHaveLength(3);
    expect(saved.data.citations.every((item: { quote: string }) => item.quote === "不存在的事实")).toBe(true);
    expect(modelCalls).toHaveLength(0);
  });
  it.each(["empty", "fetch-failed"])("A1 %s在失败前保存完整发现诊断", async kind => {
    await expect(prepare({ noSearch: kind === "empty", fetchFailure: kind === "fetch-failed" })).rejects.toThrow("MARKETING_A1_UNVERIFIED");
    const report = JSON.parse(await readFile(path.join(root, "stages/preproduction/attempt-1.marketing-A1.discovery.json"), "utf8"));
    expect(report.scope).toEqual(scope);
    expect(report.discovery).toMatchObject({ candidates: kind === "empty" ? 0 : 1, fetched: 0, sourceMode: "web" });
    expect(report.discovery.failures).toEqual(kind === "empty" ? [] : [{ url: sourceUrl, reason: "SOURCE_HTTP_FAILED：来源HTTP 403" }]);
    expect(modelCalls).toHaveLength(0);
  });
});

async function prepareRegistered(): Promise<PreparedMarketingFacts> {
  return prepareMarketingFacts({ scope, root, intent: "介绍DEMO-T001，仅使用登记摘录支持的事实", env,
    metadata: { productArchive: { id: "demo-t001" }, dataMining: { name: "示例品牌 台式双屏自助机", model: "DEMO-T001" } },
    llm: { reason: async prompt => {
      extractionCalls.push(prompt);
      const sources = JSON.parse(/当前阶段：A1\n(.*)$/s.exec(prompt)![1]!).sources;
      const source = sources[0];
      return { success: true, data: { payload: { identity: { name: "台式双屏自助机", model: "DEMO-T001", specs: { 摄像头: "角度可调节" } }, images: [] },
        citations: ["/identity/name", "/identity/model", "/identity/specs/摄像头"].map(pointer => ({ pointer, sourceId: source.sourceId, quote: source.text })) } };
    } }, dependencies: { search: async () => [], fetchSource: async () => { throw new Error("测试不允许公网来源传输"); } } });
}
describe("登记档案复用正式营销宿主资格", () => {
  it("恢复G6只复读真实G1/来源与装订，不重复模型或自报最终镜头资格", async () => {
    const prepared = await prepareRegistered(); await authorizeMarketingFacts(prepared, env);
    const input = JSON.parse(prepared.g1Content), calls = modelCalls.length;
    const restored = await restoreReviewedMarketingFacts({ root, scope, metadata: input.requestedMetadata, intent: input.requestedIntent });
    expect(restored.bundle).toEqual(prepared.bundle); expect(restored.raw).toEqual(prepared.raw); expect(restored.verdict.approved).toBe(true);
    expect(restored.bundle.outputReviews).toEqual([]); expect(modelCalls).toHaveLength(calls);
  });
  it.each(["source", "metadata", "intent", "scope", "g1-rejected", "g1-hash"])("恢复%s变化必须拒绝，不重新制作批准", async kind => {
    const prepared = await prepareRegistered(); await authorizeMarketingFacts(prepared, env);
    const original = JSON.parse(prepared.g1Content), request = { root, scope: { ...scope }, metadata: original.requestedMetadata, intent: original.requestedIntent };
    if (kind === "source") await writeFile(path.join(root, prepared.bundle.sources[0]!.textRef), "变更原文");
    if (kind === "metadata") request.metadata.characterArchive = { id: "另一人物" };
    if (kind === "intent") request.intent += "另一营销意图";
    if (kind === "scope") request.scope.workspaceId = "other";
    if (kind.startsWith("g1-")) {
      const file = path.join(root, `${prepared.prefix}-G1.verdict.json`), receipt = JSON.parse(await readFile(file, "utf8"));
      if (kind === "g1-rejected") receipt.verdict.approved = false; else receipt.contentSha256 = "0".repeat(64);
      await writeFile(file, JSON.stringify(receipt));
    }
    const calls = modelCalls.length; await expect(restoreReviewedMarketingFacts(request)).rejects.toThrow(); expect(modelCalls).toHaveLength(calls);
  });
  it("无公网商品页仍完成来源审核/G1/逐镜审核与复读；原PDF未重开明确留痕", async () => {
    const prepared = await prepareRegistered();
    expect(prepared.bundle.stages[0]!.discovery.sourceMode).toBe("registered-primary");
    expect(prepared.bundle.sources[0]!.archive?.originalReopened).toBe(false);
    expect(prepared.bundle.productQuery).toEqual({ name: "台式双屏自助机", model: "DEMO-T001" });
    expect(prepared.bundle.sourceQuery).toMatchObject({ name: "示例品牌 台式双屏自助机", model: "DEMO-T001" });
    expect(prepared.bundle.dossier.identity).toMatchObject({ name: "台式双屏自助机", brand: "", category: "",
      specs: { 摄像头: "角度可调节" } });
    expect(prepared.bundle.dossier.gaps).not.toContain('规格 "摄像头" 无来源，置信度降级');
    expect(prepared.bundle.dossier.provenance).toEqual(expect.arrayContaining([expect.objectContaining({
      claim_ref: "identity.specs.摄像头", source_url: expect.stringMatching(/^workloom-archive:/),
    })]));
    expect(extractionCalls).toHaveLength(1);
    expect(extractionCalls[0]).not.toContain("前置2MP双目人脸识别");
    const qualified = await authorizeMarketingFacts(prepared, env);
    expect(qualified.verdict).toMatchObject({ approved: true, status: "passed", via: "llm", degraded: false });
    expect(renderSha256(qualified.dataMining.verifiedRaw!.rawJson)).toBe(qualified.dataMining.verifiedRaw!.sha256);
    expect(JSON.parse(qualified.dataMining.verifiedDossier!.assemblyJson)).toEqual(prepared.bundle.assembly);
    const output = [{ shotId: "S1", prompt: "展示台式双屏自助机DEMO-T001的可调节角度摄像头。", fields: { 型号: "DEMO-T001" } }];
    const saved = await finalizeMarketingFacts(prepared, output, env);
    expect((await verifyMarketingFacts({ root, ...saved, scope, shots: output })).restrictions).toHaveLength(2);
    expect(modelCalls).toHaveLength(3); // A1语义支持、完整G1、最终镜头；评价/竞品缺证据不造内容
  });
  it("G1拒绝时保留真实裁决，不发给创意引擎", async () => {
    const prepared = await prepareRegistered(); rejectJudge = true;
    await expect(authorizeMarketingFacts(prepared, env)).rejects.toThrow("MARKETING_G1_UNVERIFIED");
    const receipt = JSON.parse(await readFile(path.join(root, `${prepared.prefix}-G1.verdict.json`), "utf8"));
    expect(receipt.verdict).toMatchObject({ approved: false, status: "failed", via: "llm" });
  });
  it.each(["raw", "scope", "query", "cards", "assembly"])("%s变化必须重审，不能复制已准备的G1", async kind => {
    const prepared = await prepareRegistered();
    if (kind === "raw") (prepared.raw.A1.identity as any).model = "DEMO-02";
    if (kind === "scope") prepared.bundle.scope.workspaceId = "other";
    if (kind === "query") prepared.bundle.productQuery.model = "DEMO-02";
    if (kind === "cards") (prepared.bundle.cards.brief_card as any).product = "别的商品";
    if (kind === "assembly") prepared.bundle.assembly!.trace_id = "changed";
    const calls = modelCalls.length;
    await expect(authorizeMarketingFacts(prepared, env)).rejects.toThrow("MARKETING_G1_UNBOUND");
    expect(modelCalls).toHaveLength(calls);
  });
});
