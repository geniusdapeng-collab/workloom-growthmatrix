/** 已核验事实到 vendor 旧回填合同的确定性投影；检索线索不参与身份兜底。 */
import type { IntelStage } from "./data-mining-executor.js";
import type { ValidatedStageFacts } from "./marketing-facts.js";
import type { SourceSnapshot } from "./marketing-source-fetcher.js";
import { canonicalRenderJson } from "./gen/compiled-request.js";

export const MARKETING_VENDOR_RAW_FORMAT = "vendor-source-fields/v1" as const;
const escapePointer = (value: string) => value.replace(/~/g, "~0").replace(/\//g, "~1");

export function projectMarketingDossierInput(
  stages: ValidatedStageFacts[], sources: Array<Pick<SourceSnapshot, "sourceId" | "finalUrl">>,
): { input: Record<string, unknown>; rawByAgent: Record<IntelStage, Record<string, unknown>> } {
  const bySource = new Map(sources.map(source => [source.sourceId, source]));
  if (bySource.size !== sources.length) throw new Error("MARKETING_SOURCE_INVALID：投影来源ID重复");
  const rawByAgent = {} as Record<IntelStage, Record<string, unknown>>;
  for (const stage of ["A1", "A2", "A3"] as const) {
    const records = stages.filter(facts => facts.stage === stage);
    if (records.length !== 1) throw new Error(`MARKETING_STAGE_UNVERIFIED：投影缺少唯一${stage}事实`);
    rawByAgent[stage] = structuredClone(records[0]!.payload);
  }
  const facts = stages.find(stage => stage.stage === "A1")!;
  const identity = rawByAgent.A1.identity as Record<string, unknown>;
  if (!identity || typeof identity.name !== "string" || !identity.name.trim()) {
    throw new Error("MARKETING_PRODUCT_REQUIRED：装订输入缺少已核验名称");
  }
  const claimFor = (pointer: string, value: unknown) => {
    const claims = facts.claims.filter(claim => claim.pointer === pointer);
    const claim = claims[0];
    if (claims.length !== 1 || !claim || canonicalRenderJson(claim.value) !== canonicalRenderJson(value)) {
      throw new Error(`MARKETING_CLAIM_UNSOURCED：投影字段与唯一原始主张不一致 ${pointer}`);
    }
    const source = bySource.get(claim.sourceId);
    if (!source) throw new Error(`MARKETING_SOURCE_INVALID：投影字段来源缺失 ${pointer}`);
    return source;
  };
  const input: Record<string, unknown> = {};
  for (const key of ["name", "brand", "category", "model"]) {
    if (identity[key] !== undefined) {
      claimFor(`/identity/${key}`, identity[key]);
      input[key] = identity[key];
    }
  }
  // vendor 接受 {value,source_url} 才登记规格来源；plain值会被其误记为“无来源”。
  identity.specs = Object.fromEntries(Object.entries(identity.specs as Record<string, unknown>).map(([key, value]) => {
    const source = claimFor(`/identity/specs/${escapePointer(key)}`, value);
    return [key, { value, source_url: source.finalUrl, channel: new URL(source.finalUrl).hostname }];
  }));
  return { input, rawByAgent };
}
