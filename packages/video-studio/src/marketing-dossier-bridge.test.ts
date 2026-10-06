import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { filmCanonicalJson } from "./film-worker-channel.js";
import { runWithReviewedMarketingDossier, validateReviewedMarketingDossier, type ReviewedMarketingDossier } from "./marketing-dossier-bridge.js";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const raw = { A1: { identity: { name: "商品" } }, A2: { reviews: [] }, A3: { competitors: [] } };
function proof(id = "P1"): ReviewedMarketingDossier {
  const assemblyJson = filmCanonicalJson({ ok: true, chain: { ok: true }, envelopes: [1, 2, 3, 4, 5],
    dossier: { identity: { name: "商品" }, built_at: id }, cards: { brief_card: { product: "商品" } } });
  return { projectId: id, assemblyJson, sha256: hash(assemblyJson), rawSha256: hash(filmCanonicalJson(raw)), productQuery: { name: "商品" } };
}
function fixture(id = "P1") {
  const original = vi.fn((_trace: string, _input: Record<string, unknown>, _raw: Record<string, unknown>): Record<string, unknown> => ({ old: true })), prototype = { assemble: original };
  const theme = vi.fn((_intent: string, _metadata: Record<string, unknown>) => "original-theme"), system = { _buildThemeInput: theme };
  return { input: { proof: proof(id), projectId: id, rawSha256: hash(filmCanonicalJson(raw)), prototype, system }, original, theme, prototype, system };
}
describe("完整G1装订快照消费", () => {
  it("返回同一已审内容的隔离副本，原装订器不重跑；退出后普通调用仍走原方法", async () => {
    const f = fixture();
    await runWithReviewedMarketingDossier(f.input, async () => {
      const a = f.prototype.assemble("new-trace", { name: "商品" }, raw);
      expect(a).toEqual(JSON.parse(f.input.proof.assemblyJson));
      (a as any).dossier.identity.name = "篡改副本";
      expect((f.prototype.assemble("again", { name: "商品" }, raw) as any).dossier.identity.name).toBe("商品");
      expect(f.system._buildThemeInput("intent", {})).toBe("original-theme");
    });
    expect(f.original).not.toHaveBeenCalled(); expect(f.system._buildThemeInput).toBe(f.theme);
    expect(f.prototype.assemble("outside", {}, {})).toEqual({ old: true }); expect(f.original).toHaveBeenCalledOnce();
  });
  it.each(["project", "hash", "raw", "chain", "envelopes"])("%s错误在执行前拒绝", async kind => {
    const f = fixture(), p = f.input.proof;
    if (kind === "project") p.projectId = "other";
    if (kind === "hash") p.sha256 = "0".repeat(64);
    if (kind === "raw") p.rawSha256 = "0".repeat(64);
    if (kind === "chain" || kind === "envelopes") {
      const a = JSON.parse(p.assemblyJson); if (kind === "chain") a.chain.ok = false; else a.envelopes = [];
      p.assemblyJson = filmCanonicalJson(a); p.sha256 = hash(p.assemblyJson);
    }
    const execute = vi.fn(async () => true);
    await expect(runWithReviewedMarketingDossier(f.input, execute)).rejects.toThrow("MARKETING_G1_REQUIRED");
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(["query", "raw"])("%s改变不能落入旧装订器或生成主题", async kind => {
    const f = fixture();
    await expect(runWithReviewedMarketingDossier(f.input, async () => {
      f.prototype.assemble("changed", kind === "query" ? { name: "另一商品" } : { name: "商品" }, kind === "raw" ? { ...raw, A1: {} } : raw);
      return true;
    })).rejects.toThrow("MARKETING_DOSSIER_CHANGED");
    expect(f.original).not.toHaveBeenCalled(); expect(f.theme).not.toHaveBeenCalled(); expect(f.system._buildThemeInput).toBe(f.theme);
  });
  it("vendor吞情报错误时主题入口仍拒绝；没有消费也不能宣告成功", async () => {
    const f = fixture();
    await expect(runWithReviewedMarketingDossier(f.input, async () => f.system._buildThemeInput("intent", {}))).rejects.toThrow("marketing confirmation");
    await expect(runWithReviewedMarketingDossier(f.input, async () => true)).rejects.toThrow("MARKETING_DOSSIER_NOT_CONSUMED");
    expect(f.theme).not.toHaveBeenCalled();
  });
  it("并发作用域共享dispatcher而快照不串；已结束异步上下文拒绝晚到消费", async () => {
    const first = fixture("A"), second = fixture("B"); second.input.prototype = first.prototype;
    let release!: () => void, ready!: () => void, late!: Promise<unknown>;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { ready = resolve; });
    const a = runWithReviewedMarketingDossier(first.input, async () => {
      ready(); await gate;
      const result = first.prototype.assemble("A", { name: "商品" }, raw);
      late = new Promise(resolve => setTimeout(() => { try { resolve(first.prototype.assemble("late", { name: "商品" }, raw)); } catch (error) { resolve(error); } }, 10));
      return result;
    });
    await started;
    const b = await runWithReviewedMarketingDossier(second.input, async () => first.prototype.assemble("B", { name: "商品" }, raw));
    expect((b as any).dossier.built_at).toBe("B"); release();
    expect((await a as any).dossier.built_at).toBe("A"); expect(await late).toMatchObject({ message: expect.stringContaining("MARKETING_DOSSIER_CLOSED") });
  });
  it("结构缺失不接受无效JSON或空快照", () => {
    const p = proof(); p.assemblyJson = "{"; p.sha256 = hash(p.assemblyJson);
    expect(() => validateReviewedMarketingDossier(p, "P1", p.rawSha256)).toThrow();
  });
  it("恢复只读同一已消费装订对象，不调用装订器或主题；改变对象在执行前拒绝", async () => {
    const f = fixture(), execute = vi.fn(async () => "resume");
    expect(await runWithReviewedMarketingDossier({ ...f.input, resumeAssembly: JSON.parse(f.input.proof.assemblyJson) }, execute)).toBe("resume");
    expect(f.original).not.toHaveBeenCalled(); expect(f.theme).not.toHaveBeenCalled();
    execute.mockClear();
    await expect(runWithReviewedMarketingDossier({ ...f.input, resumeAssembly: { changed: true } }, execute)).rejects.toThrow("MARKETING_DOSSIER_CHANGED");
    expect(execute).not.toHaveBeenCalled();
  });
});
