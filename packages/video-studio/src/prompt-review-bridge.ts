/** G6同阶段修订：原模型完整新稿、原G6/G7复审；受审稿与下游镜头保持同一对象。 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkloomLLMEngine } from "./llm-adapter.js";
import type { GateVerdict } from "./gates.js";
import { filmCanonicalJson } from "./film-worker-channel.js";
type Obj = Record<string, any>;
export interface PromptReviewTarget {
  create(...args: any[]): Promise<Obj>;
  _confirmPrompts(prompts: Obj[]): Promise<GateVerdict>;
  _confirmPreproductionResult(production: Obj, ...args: any[]): Promise<GateVerdict>;
}
const id = (shot: Obj) => String(shot.shotId ?? shot.shot_id ?? "");
const snapshot = (value: unknown) => JSON.parse(JSON.stringify(value));

export function applyPromptCorrection(original: Obj[], response: Obj, metadata: Obj): Obj[] {
  const rows = response.shots;
  if (!Array.isArray(rows) || rows.length !== original.length || new Set(rows.map(id)).size !== original.length) throw new Error("PROMPT_CORRECTION_SCOPE_CHANGED");
  const byId = new Map(rows.map((row: Obj) => [id(row), row]));
  const speed = Number.parseFloat(String(metadata.characterArchive?.persona?.speechRate ?? "3.2"));
  if (!Number.isFinite(speed) || speed <= 0) throw new Error("PROMPT_SPEECH_RATE_INVALID");
  return original.map(shot => {
    const row = byId.get(id(shot));
    if (!row || Number(row.duration) !== Number(shot.duration) || Object.keys(row).some(key => !["shotId", "duration", "fields", "prompt", "dialogueBlocks"].includes(key))) throw new Error("PROMPT_CORRECTION_SCOPE_CHANGED");
    const fields = row.fields;
    if (!fields || typeof fields !== "object" || Array.isArray(fields)
      || Object.keys(shot.fields ?? {}).some(key => typeof fields[key] !== "string" || !fields[key].trim())
      || Object.keys(fields).some(key => !(key in (shot.fields ?? {})))) throw new Error("PROMPT_CORRECTION_FIELDS_INVALID");
    if (typeof row.prompt !== "string" || row.prompt.length < 1200 || row.prompt.length > 12000) throw new Error("PROMPT_CORRECTION_INCOMPLETE");
    const blocks = row.dialogueBlocks;
    if (!Array.isArray(blocks) || blocks.some((block: Obj) => !block || typeof block.text !== "string" || typeof block.speaker !== "string")) throw new Error("PROMPT_CORRECTION_DIALOGUE_INVALID");
    const spoken = blocks.map((block: Obj) => block.text).join("");
    const visible = spoken.replace(/[\s\p{P}\p{S}]/gu, "");
    if (visible.length > Math.floor(Math.max(0, Number(shot.duration) - .4) * speed)) throw new Error(`PROMPT_DIALOGUE_DURATION_INVALID:${id(shot)}`);
    if (spoken && fields.dialogue !== spoken) throw new Error("PROMPT_CORRECTION_DIALOGUE_MISMATCH");
    if (blocks.some((block: Obj) => block.speaker !== metadata.characterArchive?.name && block.speaker !== metadata.characterArchive?.id)) throw new Error("PROMPT_CORRECTION_CAST_CHANGED");
    const next: Obj = { ...snapshot(shot), ...snapshot(fields), fields: snapshot(fields), prompt: row.prompt,
      dialogueBlocks: snapshot(blocks), dialogueText: spoken, promptCharCount: row.prompt.length,
      _formalPromptCorrection: true };
    // 所有常见别名保形同步，避免旧root文本再次覆盖当前受审字段。
    for (const [key, value] of Object.entries(fields)) next[key.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase())] = value;
    return next;
  });
}

export function installVendorPromptReviewBridge(system: PromptReviewTarget, options: {
  metadata: Obj; reviewedFacts?: Obj; llm: Pick<WorkloomLLMEngine, "reason">;
  workDir: string; projectId: string; log?: (line: string) => void;
}): () => void {
  if (![system.create, system._confirmPrompts, system._confirmPreproductionResult].every(fn => typeof fn === "function")) throw new Error("PROMPT_REVIEW_BRIDGE_UNAVAILABLE");
  const create = system.create, confirm = system._confirmPrompts, final = system._confirmPreproductionResult;
  let active = true, attempted = false, actual: Obj | undefined;
  const context = { brief: options.metadata.brief, characterArchive: options.metadata.characterArchive,
    products: options.metadata.products ?? null, usage: options.metadata.marketingUsage ?? null, reviewedFacts: options.reviewedFacts ?? null };
  context.brief ??= null; context.characterArchive ??= null;
  system._confirmPrompts = async function (prompts) {
    if (!active) throw new Error("PROMPT_REVIEW_BRIDGE_CLOSED");
    const verdict = await confirm.call(this, prompts);
    if (verdict.approved || attempted) return verdict;
    attempted = true;
    const root = join(options.workDir, "prompt-corrections", createHash("sha256").update(options.projectId).digest("hex"));
    mkdirSync(root, { recursive: true });
    const save = (name: string, value: unknown) => writeFileSync(join(root, name), `${JSON.stringify(snapshot(value), null, 2)}\n`, "utf8");
    const rejected = snapshot(prompts);
    save("rejected.json", { projectId: options.projectId, prompts: rejected, verdict });
    options.log?.("[prompt-review-bridge] G6拒绝后同阶段一次模型修订，完整稿再次送原G6/G7；不重跑上游");
    const response = await options.llm.reason(`正式提示词修订工位。当前G6拒绝理由：${verdict.reason ?? "未通过"}。只输出完整JSON {shots:[{shotId,duration,fields,prompt,dialogueBlocks:[{speaker,type,emotion,text}]}]}。
每个原镜号恰好一次，时长严格不变，fields键集合与原镜完全相同，所有字段为完整中文字符串；prompt包含与这些字段相符的完整最终生成指令（1200–3500字）。只修正实际矛盾，保留原剧本的产品宣传目的；禁止把过程元数据、JSON、属性ID或修订要求当动作/台词。技术格式MP4/H.264/fps/K/asset引用允许原准确语法，创意和对白中文。
以登记人物appearance及唯一wardrobe为实际造型，全片不换发型衣装；无人产品镜没有手/人体/访客，允许CEO画外音。所有口播只取本次G1支持事实，删除未支持效果标题。每镜口播字数不超过floor((duration-0.4)*${Number.parseFloat(String(options.metadata.characterArchive?.persona?.speechRate ?? "3.2"))})，必须真正缩短台词，不改时长；每个对白块speaker为登记角色名，fields.dialogue等于块text拼接，无对白用空块和明确无对白字符串。
镜内audio仅同期人声、真实环境音，不含音乐/BGM/BPM；配乐留正式后期。每镜时间轴始终在0至本镜duration内。商品外观按登记图，不拼造两块屏幕一体机械结构，不把选配单/双屏说成即时切换。保留既有合法引用，不新造定妆照路径。原稿fields、prompt中不存在的商品性能绝不可新增。
实际受审制作输入：${filmCanonicalJson(context)}
原候选：${filmCanonicalJson(prompts.map(shot => ({ shotId: id(shot), duration: shot.duration, fields: shot.fields,
      prompt: shot.prompt, dialogueBlocks: shot.dialogueBlocks ?? [] })))}`,
    { forceJson: true, maxTokens: 32768, temperature: .1, thinking: { type: "disabled" } });
    save("model-response.json", response);
    if (!active || !response.success) throw new Error(`prompt confirmation：正式修订失败 ${response.error ?? "作用域已关闭"}`);
    const candidate = applyPromptCorrection(prompts, response.data ?? JSON.parse(response.content ?? ""), options.metadata);
    save("candidate.json", candidate);
    const next = await confirm.call(this, candidate);
    save("verdict.json", next);
    if (!active) throw new Error("PROMPT_REVIEW_BRIDGE_CLOSED");
    if (next.approved) prompts.splice(0, prompts.length, ...candidate);
    return next;
  };
  system._confirmPreproductionResult = async function (production, ...args) {
    if (!active) throw new Error("PROMPT_REVIEW_BRIDGE_CLOSED");
    // 原vendor在增强前分离shots/prompts；G7、导出与已受审提示词须消费同一实际稿。
    const prompts: Obj[] = production.prompts ?? [];
    const byId = new Map(prompts.map(shot => [id(shot), shot]));
    production.shots = (production.shots ?? []).map((shot: Obj) => {
      const current = byId.get(id(shot));
      if (!current || Number(current.duration) !== Number(shot.duration)) throw new Error("PROMPT_FINAL_SCOPE_CHANGED");
      return snapshot(current);
    });
    actual = production;
    return final.call(this, production, ...args);
  };
  system.create = async function (...args) {
    if (!active) throw new Error("PROMPT_REVIEW_BRIDGE_CLOSED");
    const result = await create.apply(this, args);
    if (!active) throw new Error("PROMPT_REVIEW_BRIDGE_CLOSED");
    if (actual && result.stages?.productionEngine) {
      result.stages.productionEngine.shots = snapshot(actual.shots);
      result.stages.productionEngine.prompts = snapshot(actual.prompts);
    }
    return result;
  };
  return () => { if (!active) return; active = false; system.create = create; system._confirmPrompts = confirm; system._confirmPreproductionResult = final; };
}
