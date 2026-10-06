/** PRD正式生成/审核衔接：只映射明确口径，不代写创意或绕过审核。 */
import type { GateVerdict } from "./gates.js";
import type { WorkloomLLMEngine } from "./llm-adapter.js";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
type Recordish = Record<string, any>;
interface Generator {
  generate(discovery: Recordish): Promise<Recordish>;
  generateMarkdown(prd: Recordish): string;
  agent2?: { _buildPrompt(discovery: Recordish, creative?: Recordish): string };
  agent3?: { _buildPrompt(discovery: Recordish, creative?: Recordish): string };
}
export interface PrdBridgeTarget {
  prdGenerator: Generator;
  _confirmPRD(markdown: string, prd: Recordish): Promise<GateVerdict>;
}
const object = (value: unknown): Recordish => value && typeof value === "object" && !Array.isArray(value) ? value as Recordish : {};

export function alignPrdDelivery(prd: Recordish, metadata: Recordish): void {
  const brief = object(metadata.brief);
  if (brief.platform) prd.productPositioning.targetPlatform = brief.platform;
  if (brief.aspectRatio) prd.productPositioning.aspectRatio = brief.aspectRatio;
  if (brief.resolution) prd.productPositioning.resolution = brief.resolution;
  if (brief.frameRate) prd.productPositioning.frameRate = brief.frameRate;
  const format = object(prd.deliveryStandard?.outputFormat);
  if (brief.videoCodec) format.videoCodec = brief.videoCodec;
  if (Array.isArray(prd.deliveryStandard?.deliverables) && prd.productPositioning.resolution) {
    for (const item of prd.deliveryStandard.deliverables) if (item.item === "video_master") {
      item.spec = [format.container, format.videoCodec, prd.productPositioning.resolution, prd.productPositioning.aspectRatio,
        prd.productPositioning.frameRate ? `${prd.productPositioning.frameRate}fps` : ""].filter(Boolean).join(" / ");
    }
  }
  const production = object(prd.productionConstraints?.qualityThresholds);
  const delivery = object(prd.deliveryStandard?.acceptanceCriteria);
  const aligned: Record<string, number> = {};
  for (const key of ["visual", "audio", "narrative", "consistency"]) {
    const values = [production[key], delivery[key]].filter(value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1);
    if (!values.length) throw new Error(`PRD_QUALITY_INVALID: ${key}没有可执行阈值`);
    aligned[key] = Math.max(...values);
  }
  prd.productionConstraints.qualityThresholds = { ...aligned };
  prd.deliveryStandard.acceptanceCriteria = { ...aligned };
  prd.deliveryStandard.fallbackPlan.trigger = `任一质量项低于统一验收阈值（${JSON.stringify(aligned)}）；仅在未提交镜头前调整制作方案，已提交镜头不自动重渲染`;
}

/** 固定实例内完整生成器；重生成的稿件须再次通过原G4，晚到调用拒绝。 */
export function installVendorPrdBridge(system: PrdBridgeTarget, metadata: Recordish, log: (line: string) => void = () => undefined,
  reviewedFacts?: Recordish, correction?: { llm: Pick<WorkloomLLMEngine, "reason">; workDir: string; projectId: string }): () => void {
  const generator = system.prdGenerator;
  if (!generator || typeof generator.generate !== "function" || typeof generator.generateMarkdown !== "function" || typeof system._confirmPRD !== "function") {
    throw new Error("PRD_BRIDGE_UNAVAILABLE");
  }
  const originalGenerate = generator.generate, originalMarkdown = generator.generateMarkdown;
  const originalConfirm = system._confirmPRD;
  if ([generator.agent2, generator.agent3].some(agent => !agent || typeof agent._buildPrompt !== "function")) throw new Error("PRD_PROMPT_CONSUMER_MISSING");
  const promptBuilders: Array<{ agent: NonNullable<Generator["agent2"]>; original: NonNullable<Generator["agent2"]>["_buildPrompt"] }> = [];
  const facts = { brief: metadata.brief, characterArchive: metadata.characterArchive, characters: metadata.characters,
    marketingUsage: metadata.marketingUsage, products: metadata.products };
  const clause = `\n【正式制作输入】\n${JSON.stringify(facts)}\n只使用原始意图允许的宣称；否定限制不是可用卖点。明确人物亲自介绍时必须生成其可执行的短口播，不能改为无对白。核查建议中的字数、批次、审核日志只用于交付校验，不是创意内容、道具、台词或特效。userModifications中的指令须实际落实到本次输出，不复制“改写/替换/补一条”等过程指令。只保留与本次商业基调及场景相符的参考，删除无关史诗案例。复用已登记front/threeQuarter/closeup/side四角度，不新生成。保留opening、主体与ending的实际场景。`;
  let active = true, count = 0;
  let corrected = false;
  if (correction) system._confirmPRD = async function (markdown, prd) {
    if (!active) throw new Error("PRD_BRIDGE_CLOSED");
    const verdict = await originalConfirm.call(this, markdown, prd);
    if (verdict.approved || corrected) return verdict;
    corrected = true;
    const root = join(correction.workDir, "prd-corrections", createHash("sha256").update(correction.projectId).digest("hex"));
    mkdirSync(root, { recursive: true });
    const save = (name: string, value: unknown): void => writeFileSync(join(root, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
    save("rejected.json", { projectId: correction.projectId, prd, verdict });
    log("[prd-bridge] 同阶段一次正式模型修订；复用已批准来源/需求，完整新稿重新送G4");
    const response = await correction.llm.reason(`正式PRD修订工位。当前G4拒绝理由：${verdict.reason ?? "未通过"}。只输出修订后的完整PRD JSON，字段结构保持一致。
只修复实际指出的计划矛盾、时间轴、未获支持的隐喻与过程指令残留；不新增商品性能、效果、比较、授权或已验收结论。明确时长、人物、商品外观、交付规格和质量阈值保持不变。不保留第50秒等超出片长的模板；不能把“修改/将…改为…”指令当实际制作内容。
完整原稿：${JSON.stringify(prd)}\n明确制作输入：${JSON.stringify(facts)}\nG1受审事实：${JSON.stringify(reviewedFacts ?? null)}`,
      { forceJson: true, maxTokens: 16384, temperature: .1, thinking: { type: "disabled" } });
    save("model-response.json", response);
    if (!active || !response.success) throw new Error(`prd confirmation：正式修订失败 ${response.error ?? "作用域已关闭"}`);
    const candidate = object(response.data ?? JSON.parse(response.content ?? ""));
    if (!candidate.productPositioning || !candidate.productionConstraints || !candidate.deliveryStandard) throw new Error("prd confirmation：修订稿缺原PRD结构");
    candidate.productionConstraints.qualityThresholds = structuredClone(prd.productionConstraints.qualityThresholds);
    candidate.deliveryStandard.acceptanceCriteria = structuredClone(prd.deliveryStandard.acceptanceCriteria);
    alignPrdDelivery(candidate, metadata);
    if (Number(candidate.productPositioning.targetDuration) !== Number(prd.productPositioning.targetDuration)) throw new Error("prd confirmation：修订稿改变明确时长");
    save("candidate.json", candidate);
    const next = await originalConfirm.call(this, generator.generateMarkdown(candidate), candidate);
    save("verdict.json", next);
    if (!active || !next.approved) return next;
    for (const key of Object.keys(prd)) delete prd[key];
    Object.assign(prd, candidate);
    return next;
  };
  for (const agent of [generator.agent2, generator.agent3]) {
    if (!agent || typeof agent._buildPrompt !== "function") throw new Error("PRD_PROMPT_CONSUMER_MISSING");
    const original = agent._buildPrompt;
    promptBuilders.push({ agent, original });
    agent._buildPrompt = function (discovery, creative) {
      if (!active) throw new Error("PRD_BRIDGE_CLOSED");
      return `${original.call(this, discovery, creative)}${clause}`;
    };
  }
  generator.generateMarkdown = function (prd) {
    const cast = object(metadata.characterArchive);
    const reference = cast.id ? `\n\n## 明确登记角色与引用（本地登记，平台有效性另行核实）\n${JSON.stringify({ id: cast.id, name: cast.name,
      authorization: cast.authorization, portraitSets: cast.portraitSets })}\n` : "";
    const factsText = reviewedFacts ? `\n\n## 本次G1受审商品宣传档案\n${JSON.stringify(reviewedFacts, (_key, value) => value === null ? "未提供（原档案空值）" : value)}\n此内容来自宿主受审快照，空字段显示为明确的未提供；原档案与摘要保留原值。登记摘录不代表本次重开原PDF。\n` : "";
    const delivery = metadata.brief?.delivery ? `\n\n## 明确交付合同（待后期实测，不宣称已产出）\n${JSON.stringify(metadata.brief.delivery)}\n` : "";
    // 原生成器末尾是交互UI提示与未记录计时，不属于送审的制作文档。
    const markdown = originalMarkdown.call(this, prd).replace(/^\*\*请回复：确认 \/ 修改：xxx \/ 重新生成\*\*\s*$/gm, "")
      .replace(/^> PRD 生成耗时：未记录ms\s*$/gm, "");
    return `${markdown}${reference}${factsText}${delivery}`;
  };
  generator.generate = async function (discovery) {
    if (!active) throw new Error("PRD_BRIDGE_CLOSED");
    const enriched = structuredClone(discovery);
    // 两个原Agent只读顶层原文，vendor实际把原文放在upstreamFields。
    enriched._originalStoryText = enriched._originalStoryText || enriched.upstreamFields?._originalStoryText || enriched.upstreamFields?.original_story_text || "";
    const prd = await originalGenerate.call(this, enriched);
    if (!active) throw new Error("PRD_BRIDGE_CLOSED");
    alignPrdDelivery(prd, metadata);
    // Agent4规则引擎会把userModifications截断后当作约束。完整建议仍交给Agent2/3模型，
    // 规则生成的过程句不应伪装为实际制作约束；原文与评审裁决另有完整保存。
    for (const key of ["technicalConstraints", "businessConstraints", "forbiddenElements"]) {
      if (Array.isArray(prd.productionConstraints?.[key])) prd.productionConstraints[key] = prd.productionConstraints[key]
        .filter((item: unknown) => typeof item !== "string" || !item.startsWith("用户要求: "));
    }
    if (Array.isArray(prd.visualSpecification?.visualReferences) && prd.referenceCases) {
      prd.referenceCases.filmReferences = structuredClone(prd.visualSpecification.visualReferences);
    }
    count += 1;
    if (count > 1) {
      log("[prd-bridge] 审核建议触发新稿，完整稿重新进入G4");
      const verdict = await system._confirmPRD(this.generateMarkdown(prd), prd);
      if (!active || !verdict.approved) throw new Error(`prd confirmation：重生成稿未通过G4 ${verdict.reason ?? ""}`);
    }
    return prd;
  };
  return () => {
    if (!active) return;
    active = false; generator.generate = originalGenerate; generator.generateMarkdown = originalMarkdown;
    system._confirmPRD = originalConfirm;
    for (const { agent, original } of promptBuilders) agent._buildPrompt = original;
  };
}
