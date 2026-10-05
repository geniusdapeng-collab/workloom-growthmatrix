import { describe, expect, it } from "vitest";
import { projectMarketingDossierInput } from "./marketing-dossier-input.js";
import { validateStageFacts } from "./marketing-facts.js";
import { renderSha256 } from "./gen/compiled-request.js";
import type { SourceSnapshot } from "./marketing-source-fetcher.js";

const text = "台式自助机 DEMO-T001。角度可调摄像头。版本0，支持状态false。";
const source: SourceSnapshot = { sourceId: "SRC-1", requestedUrl: "workloom-archive://demo-t001/profile/hash",
  finalUrl: "workloom-archive://demo-t001/profile/hash", redirectChain: [], fetchedAt: "2026-10-05T00:00:00Z",
  contentType: "text/plain", rawSha256: renderSha256(text), textSha256: renderSha256(text), bytes: Buffer.byteLength(text), text, assetUrls: [] };
function fixture() {
  const payload = { identity: { name: "台式自助机", model: "DEMO-T001", specs: { 摄像头: "角度可调摄像头", "a/b~c": 0, 支持: false } }, images: [] };
  const citations = ["/identity/name", "/identity/model", "/identity/specs/摄像头", "/identity/specs/a~1b~0c", "/identity/specs/支持"]
    .map(pointer => ({ pointer, sourceId: source.sourceId, quote: text }));
  return [validateStageFacts("A1", { payload, citations }, [source]),
    validateStageFacts("A2", { payload: { reviews: [] }, citations: [], noEvidenceReason: "无评价正文" }, []),
    validateStageFacts("A3", { payload: { competitors: [] }, citations: [], noEvidenceReason: "无竞品正文" }, [])];
}
describe("事实装订投影", () => {
  it("身份仅来自已核验叶子；规格保留值、逐项来源和转义键，零/false不会丢失", () => {
    const stages = fixture(), original = structuredClone(stages);
    const projected = projectMarketingDossierInput(stages, [source]);
    expect(projected.input).toEqual({ name: "台式自助机", model: "DEMO-T001" });
    expect(projected.rawByAgent.A1.identity).toMatchObject({ specs: {
      摄像头: { value: "角度可调摄像头", source_url: source.finalUrl, channel: "demo-t001" },
      "a/b~c": { value: 0, source_url: source.finalUrl }, 支持: { value: false, source_url: source.finalUrl },
    } });
    expect(projected.rawByAgent.A2).toEqual({ reviews: [] });
    expect(projected.rawByAgent.A3).toEqual({ competitors: [] });
    expect(stages).toEqual(original);
  });
  it.each(["value", "missing-claim", "duplicate-claim", "source", "identity"])("%s变化不能取得装订来源", kind => {
    const stages = fixture();
    if (kind === "value") (stages[0]!.payload.identity as any).specs.摄像头 = "零秒识别";
    if (kind === "missing-claim") stages[0]!.claims.pop();
    if (kind === "duplicate-claim") stages[0]!.claims.push(stages[0]!.claims[0]!);
    if (kind === "source") stages[0]!.claims[0]!.sourceId = "SRC-other";
    if (kind === "identity") (stages[0]!.payload.identity as any).brand = "未经核验的品牌";
    expect(() => projectMarketingDossierInput(stages, [source])).toThrow();
  });
  it("重复来源和缺/重复阶段必须拒绝", () => {
    expect(() => projectMarketingDossierInput(fixture(), [source, source])).toThrow("MARKETING_SOURCE_INVALID");
    expect(() => projectMarketingDossierInput(fixture().slice(0, 2), [source])).toThrow("MARKETING_STAGE_UNVERIFIED");
    expect(() => projectMarketingDossierInput([...fixture(), fixture()[0]!], [source])).toThrow("MARKETING_STAGE_UNVERIFIED");
  });
});
