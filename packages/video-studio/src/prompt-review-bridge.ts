/** G6同阶段修订：原模型完整新稿、原G6/G7复审；受审稿与下游镜头保持同一对象。 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkloomLLMEngine } from "./llm-adapter.js";
import type { GateVerdict } from "./gates.js";
import { filmCanonicalJson } from "./film-worker-channel.js";
type Obj = Record<string, any>;
export interface PromptReviewTarget {
  create(...args: any[]): Promise<Obj>;
  _confirmPrompts(prompts: Obj[]): Promise<GateVerdict>;
  _confirmPreproductionResult(production: Obj, ...args: any[]): Promise<GateVerdict>;
  stabilityShield?: { updateHeartbeat?(name: string): void };
  _generatePromptsReport?(prompts: Obj[]): string;
  _generatePreproductionReport?(production: Obj, script: Obj, timing: Obj, confirmations: Obj): string;
}
const id = (shot: Obj) => String(shot.shotId ?? shot.shot_id ?? "");
const snapshot = (value: unknown) => JSON.parse(JSON.stringify(value));
const OPENING_FIELDS = ["title_content", "subtitle_content", "title_animation", "title_font_design", "opening_audio_design"];

/** 复读本工位实际生成的完整候选；这不是复用批准，后续仍执行本次原G6/G7。 */
export function readPromptCorrectionCheckpoint(root: string, projectId: string, original: Obj[], metadata: Obj): Obj[] | null {
  const parent = join(root, "prompt-corrections");
  if (!existsSync(parent)) return null;
  const prefix = createHash("sha256").update(projectId).digest("hex");
  const scopes = readdirSync(parent).filter(name => new RegExp(`^${prefix}-[a-f0-9-]{36}$`).test(name))
    .map(name => join(parent, name)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const scope of scopes) {
    const rejectedPath = join(scope, "rejected.json"), candidatePath = join(scope, "candidate.json");
    if (!existsSync(rejectedPath) || !existsSync(candidatePath)) continue;
    const rejected = JSON.parse(readFileSync(rejectedPath, "utf8"));
    if (rejected.projectId !== projectId || filmCanonicalJson(rejected.prompts) !== filmCanonicalJson(snapshot(original))) continue;
    const candidate = JSON.parse(readFileSync(candidatePath, "utf8"));
    const responses = ["model-response-2.json", "model-response-1.json", "model-response.json"];
    let matches = false; const errors: string[] = [];
    for (const name of responses) {
      const file = join(scope, name); if (!existsSync(file)) continue;
      const response = JSON.parse(readFileSync(file, "utf8"));
      if (response.success !== true) continue;
      try {
        const computed = applyPromptCorrection(original, response.data ?? JSON.parse(response.content ?? ""), metadata);
        if (filmCanonicalJson(computed) === filmCanonicalJson(candidate)) { matches = true; break; }
      } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    }
    if (!matches) throw new Error(`PROMPT_CORRECTION_CHECKPOINT_CHANGED：候选不等于实际模型响应及原镜合同；${errors.join("；")}`);
    return candidate;
  }
  return null;
}

export function applyPromptCorrection(original: Obj[], response: Obj, metadata: Obj): Obj[] {
  const rows = response.shots;
  if (!Array.isArray(rows) || rows.length !== original.length || new Set(rows.map(id)).size !== original.length) throw new Error("PROMPT_CORRECTION_SCOPE_CHANGED");
  const byId = new Map(rows.map((row: Obj) => [id(row), row]));
  const speed = Number.parseFloat(String(metadata.characterArchive?.persona?.speechRate ?? "3.2"));
  if (!Number.isFinite(speed) || speed <= 0) throw new Error("PROMPT_SPEECH_RATE_INVALID");
  return original.map(shot => {
    const row = byId.get(id(shot));
    if (!row || Number(row.duration) !== Number(shot.duration) || Object.keys(row).some(key => !["shotId", "duration", "fields", "prompt", "dialogueBlocks"].includes(key))) throw new Error(`PROMPT_CORRECTION_SCOPE_CHANGED:${id(shot)}:只允许shotId/duration/fields/prompt/dialogueBlocks且时长不变`);
    const fields = row.fields;
    const requiredFields = [...new Set([...Object.keys(shot.fields ?? {}), ...(shot.sceneType === "opening" ? OPENING_FIELDS : [])])];
    if (!fields || typeof fields !== "object" || Array.isArray(fields)
      || requiredFields.some(key => typeof fields[key] !== "string" || !fields[key].trim())
      || Object.keys(fields).some(key => !requiredFields.includes(key))) throw new Error(`PROMPT_CORRECTION_FIELDS_INVALID:${id(shot)}:所有且仅有约定字段，全部为非空字符串`);
    if (typeof row.prompt !== "string" || row.prompt.length < 1200 || row.prompt.length > 12000) throw new Error("PROMPT_CORRECTION_INCOMPLETE");
    const blocks = row.dialogueBlocks;
    if (!Array.isArray(blocks) || blocks.some((block: Obj) => !block || typeof block.text !== "string" || typeof block.speaker !== "string")) throw new Error("PROMPT_CORRECTION_DIALOGUE_INVALID");
    const spoken = blocks.map((block: Obj) => block.text).join("");
    const visible = spoken.replace(/[\s\p{P}\p{S}]/gu, "");
    if (visible.length > Math.floor(Math.max(0, Number(shot.duration) - .4) * speed)) throw new Error(`PROMPT_DIALOGUE_DURATION_INVALID:${id(shot)}`);
    if (spoken && fields.dialogue !== spoken) throw new Error("PROMPT_CORRECTION_DIALOGUE_MISMATCH");
    if (blocks.some((block: Obj) => block.speaker !== metadata.characterArchive?.name && block.speaker !== metadata.characterArchive?.id)) throw new Error("PROMPT_CORRECTION_CAST_CHANGED");
    const runtime: Obj = {};
    for (const key of ["shotId", "shot_id", "duration", "timing", "sceneType", "sceneId", "worldId", "allocation"]) if (shot[key] !== undefined) runtime[key] = snapshot(shot[key]);
    // 旧增强层会留下已被修订稿替换的title/characterDescs/audioLayer等副本。
    // 原稿完整保存在rejected.json；当前制作对象只携带实际模型新稿和固定运行标识。
    const next: Obj = { ...runtime, ...snapshot(fields), fields: snapshot(fields), prompt: row.prompt,
      dialogueBlocks: snapshot(blocks), dialogueText: spoken, promptCharCount: row.prompt.length,
      _formalPromptCorrection: true, promptCorrectionSourceSha256: createHash("sha256").update(filmCanonicalJson(snapshot(shot))).digest("hex") };
    // 所有常见别名保形同步，避免旧root文本再次覆盖当前受审字段。
    for (const [key, value] of Object.entries(fields)) next[key.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase())] = value;
    return next;
  });
}

export function installVendorPromptReviewBridge(system: PromptReviewTarget, options: {
  metadata: Obj; reviewedFacts?: Obj; llm: Pick<WorkloomLLMEngine, "reason">;
  workDir: string; projectId: string; log?: (line: string) => void;
  reuseGeneratedCandidate?: boolean; reusedPortraits?: Obj | null;
  prepareFinalCandidate?: (production: Obj, script: Obj, timing: Obj, confirmations: Obj) => Promise<Obj>;
}): () => void {
  if (![system.create, system._confirmPrompts, system._confirmPreproductionResult].every(fn => typeof fn === "function")) throw new Error("PROMPT_REVIEW_BRIDGE_UNAVAILABLE");
  const create = system.create, confirm = system._confirmPrompts, final = system._confirmPreproductionResult;
  const report = system._generatePromptsReport;
  const finalReport = system._generatePreproductionReport;
  if (report) system._generatePromptsReport = function (prompts) {
    if (!active) throw new Error("PROMPT_REVIEW_BRIDGE_CLOSED");
    // 原UI报告会给无人镜加面部描述、复制陈旧片头、误标有定妆照。审核对象保持原始实际稿。
    return filmCanonicalJson({ schemaVersion: "workloom.formal-prompt-review/v1", projectId: options.projectId,
      shots: snapshot(prompts), note: "逐镜fields与完整prompt为实际生成候选；不做报告层创作或自动补词，不宣称已渲染/听音验收" });
  };
  if (finalReport) system._generatePreproductionReport = function (production, script, timing, confirmations) {
    if (!active) throw new Error("PROMPT_REVIEW_BRIDGE_CLOSED");
    if (production.formalFilmCandidate) return filmCanonicalJson({ schemaVersion: "workloom.formal-preproduction-review/v1", projectId: options.projectId,
      film: production.formalFilmCandidate, reusedPortraits: options.reusedPortraits ?? null,
      currentDecisions: { prd: { approved: confirmations.prd?.approved, sourceSha256: createHash("sha256").update(filmCanonicalJson(confirmations.prd?.prd)).digest("hex") },
        prompts: { approved: confirmations.prompts?.approved, reason: confirmations.prompts?.reason ?? null },
        environment: production.formalFilmCandidate.exportProvenance.environmentReview },
      historicalSources: { scriptSha256: createHash("sha256").update(filmCanonicalJson(script ?? null)).digest("hex"),
        preRepairQualitySha256: createHash("sha256").update(filmCanonicalJson(production.quality ?? null)).digest("hex"),
        priorDecisionsSha256: createHash("sha256").update(filmCanonicalJson(confirmations ?? null)).digest("hex") },
      note: "本门当前对象是完成正式G6修订与环境/钩子合同补全的完整film及已登记人验图片。原剧本验证、旧quality、旧G7是修订前历史证据，原文保存在结果，不冒称当前已通过。当前台词与口播预算重新确定性校验，所有创意字段来自实际生成物。本门核对镜头卡/定妆照/提示词与当前场景合同；渲染、口型、听音由后续真实工位验证，不能在花额度之前要求已有成片。G1支持的宣传面已受审，未宣传的价格/官方卖点不是本片必需事实。登记商品图与G1网络采集图分开记账，不能将网络0图当登记图不存在。" });
    const cleanShot = (shot: Obj) => {
      const copy = snapshot(shot);
      for (const [key, value] of Object.entries(shot.fields ?? {})) {
        for (const alias of [key, key.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase())]) {
          if (copy[alias] !== undefined && filmCanonicalJson(copy[alias]) === filmCanonicalJson(value)) delete copy[alias];
        }
      }
      return copy;
    };
    const uniqueProduction = snapshot(production);
    uniqueProduction.shots = (production.shots ?? []).map(cleanShot);
    const shotsHash = createHash("sha256").update(filmCanonicalJson(production.shots ?? [])).digest("hex");
    const promptsHash = createHash("sha256").update(filmCanonicalJson(production.prompts ?? [])).digest("hex");
    if (shotsHash !== promptsHash) throw new Error("PROMPT_FINAL_SCOPE_CHANGED：G7镜头与提示词不是同一已审完整稿");
    delete uniqueProduction.prompts;
    const decisions = Object.fromEntries(Object.entries(confirmations ?? {}).map(([name, record]) => {
      const source = record as Obj;
      return [name, { approved: source.approved, skipped: source.skipped ?? false, reviewedAt: source.reviewedAt ?? null,
        reason: source.reason ?? null, sourceRecordSha256: createHash("sha256").update(filmCanonicalJson(source)).digest("hex") }];
    }));
    return filmCanonicalJson({ schemaVersion: "workloom.formal-preproduction-review/v1", projectId: options.projectId,
      production: uniqueProduction, script: snapshot(script ?? null), timing: snapshot(timing ?? null), confirmations: decisions,
      binding: { shotsSha256: shotsHash, promptsSha256: promptsHash, identical: true },
      reusedPortraits: options.reusedPortraits ?? null,
      note: "完整实际镜头、逐镜提示词及原剧本。shots/prompts相同数组只呈现一次，逐值相同的字段别名只呈现fields原键；原决定记录按摘要绑定，当前完整稿仍送本次原G7。没有截断独有创意或剧本。portraitGeneration是旧新出图阶段；reusedPortraits是已登记且人验的既有资产，没有新出图或新造G5裁决。sceneType是原分镜叙事节拍标签，不是G1商品冲突字段。此处尚未渲染、听音或验收成片。" });
  };
  let active = true, attempted = false, actual: Obj | undefined, pendingActualRejection: { verdict: GateVerdict; candidate: Obj } | undefined;
  const context = { brief: options.metadata.brief, characterArchive: options.metadata.characterArchive,
    products: options.metadata.products ?? null, usage: options.metadata.marketingUsage ?? null, reviewedFacts: options.reviewedFacts ?? null };
  context.brief ??= null; context.characterArchive ??= null;
  system._confirmPrompts = async function (prompts) {
    if (!active) throw new Error("PROMPT_REVIEW_BRIDGE_CLOSED");
    const heartbeat = setInterval(() => { if (active) system.stabilityShield?.updateHeartbeat?.("ProductionEngine"); }, 15000);
    try {
    const recovered = options.reuseGeneratedCandidate ? readPromptCorrectionCheckpoint(options.workDir, options.projectId, prompts, options.metadata) : null;
    if (recovered) options.log?.("[prompt-review-bridge] 复读同原镜合同的实际模型候选；不重复生成，重新送原G6/G7审核");
    const reviewedPrompts = recovered ?? prompts;
    const actualRejection = pendingActualRejection; pendingActualRejection = undefined;
    const verdict = actualRejection?.verdict ?? await confirm.call(this, reviewedPrompts);
    if (verdict.approved) { if (recovered) prompts.splice(0, prompts.length, ...recovered); return verdict; }
    if (attempted || !options.metadata.characterArchive?.id) return verdict;
    attempted = true;
    const root = join(options.workDir, "prompt-corrections", `${createHash("sha256").update(options.projectId).digest("hex")}-${randomUUID()}`);
    mkdirSync(root, { recursive: true });
    const save = (name: string, value: unknown) => writeFileSync(join(root, name), `${JSON.stringify(snapshot(value), null, 2)}\n`, "utf8");
    const rejected = snapshot(reviewedPrompts);
    save("rejected.json", { projectId: options.projectId, prompts: rejected, verdict,
      ...(actualRejection ? { actualCompleteContractRejection: actualRejection } : {}) });
    options.log?.("[prompt-review-bridge] G6拒绝后同阶段一次模型修订，完整稿再次送原G6/G7；不重跑上游");
    const contract = reviewedPrompts.map(shot => ({ shotId: id(shot), duration: shot.duration,
      requiredFields: [...new Set([...Object.keys(shot.fields ?? {}), ...(shot.sceneType === "opening" ? OPENING_FIELDS : [])])],
      maximumSpokenCharacters: Math.floor(Math.max(0, Number(shot.duration) - .4) * Number.parseFloat(String(options.metadata.characterArchive?.persona?.speechRate ?? "3.2"))) }));
    const instruction = `正式提示词修订工位。当前G6拒绝理由：${verdict.reason ?? "未通过"}。只输出完整JSON {shots:[{shotId,duration,fields,prompt,dialogueBlocks:[{speaker,type,emotion,text}]}]}。
顶层只有shots。每个镜头对象恰好五个键shotId/duration/fields/prompt/dialogueBlocks，禁止额外sceneType等键。fields只有该镜requiredFields内的键，全部为非空字符串；dialogueBlocks只在镜头顶层，绝不能复制进fields。无人无对白镜fields.dialogue写“无对白”，不能空字符串。口播上限按maximumSpokenCharacters逐镜计算，中文标点不计；字段对白与块text拼接一致，绝不能超限。
每个原镜号恰好一次，时长严格不变，fields包含原镜全部字段；sceneType为opening时另外补齐title_content/subtitle_content/title_animation/title_font_design/opening_audio_design五个真实片头计划字段，其余镜不添加。标题仅用于封面/旁挂设计，视频母版和生成镜内不绘字；开场音频仅环境音或人声，音乐留后期。所有字段为完整中文字符串；prompt包含与这些字段相符的完整最终生成指令（1200–3500字）。只修正实际矛盾，保留原剧本的产品宣传目的；禁止把过程元数据、JSON、属性ID或修订要求当动作/台词。技术格式MP4/H.264/fps/K/asset引用允许原准确语法，创意和对白中文，不再添加“禁止所有英文”自相矛盾规则。分辨率只写明确1080×1920，不写8K或4K超采样。
以登记人物appearance及唯一wardrobe为实际造型，全片不换发型衣装；无人产品镜没有手/人体/访客，允许CEO画外音。所有口播只取本次G1支持事实，删除未支持效果标题。每镜口播字数不超过floor((duration-0.4)*${Number.parseFloat(String(options.metadata.characterArchive?.persona?.speechRate ?? "3.2"))})，必须真正缩短台词，不改时长；每个对白块speaker为登记角色名，fields.dialogue等于块text拼接，无对白用空块和明确无对白字符串。
镜内audio仅同期人声、真实环境音，不含音乐/BGM/BPM；配乐留正式后期。每镜时间轴始终在0至本镜duration内。无人镜的action/timeline/composition/mood一致保持无人，不能包含手掌、人体、面部、眼神、身影进出或脚步表演；只允许产品、机位、真实环境的可执行运动，不能靠“窗光一秒内扫动”冒充真实运动。基调按明确轻快明朗，不沿用冷静庄重或怀旧模板。商品外观按登记图，不拼造两块屏幕一体机械结构，不把选配单/双屏说成即时切换。保留既有合法引用，不新造定妆照路径。原稿fields、prompt中不存在的商品性能绝不可新增。
同一个真实柜台空间的台面、背景、窗光方向/色温/时段、产品与人物左右位置必须逐镜统一；相邻硬切不能无依据翻转站位。每个prompt中的对白、舞台动作与fields.action/timeline保持完全一致，不能保留旧稿动作副本。未被G1逐条支持的机身不变、效果承诺等短语必须由模型删去；只介绍明确支持的配置与摄像头角度，不新增效果推断。
配置可选并不证明“机身不变”“即时切换”等效果，未被G1明确支持的事实绝不添加。
必须精确遵守的逐镜输出契约：${filmCanonicalJson(contract)}
实际受审制作输入：${filmCanonicalJson(context)}
原候选：${filmCanonicalJson(reviewedPrompts.map(shot => ({ shotId: id(shot), duration: shot.duration, fields: shot.fields,
      sceneType: shot.sceneType ?? null, openingPlan: Object.fromEntries(OPENING_FIELDS.map(key => [key, shot[key] ?? null])),
      prompt: shot.prompt, dialogueBlocks: shot.dialogueBlocks ?? [] })))}`;
    let candidate: Obj[] | undefined, lastError: unknown;
    let repairFeedback = "";
    // 仅对模型返回的契约错误反馈一次；合法稿只送原G6一次，不重复上游或渲染。
    for (let attempt = 1; attempt <= 2; attempt++) {
      const response = await options.llm.reason(instruction + repairFeedback,
        { forceJson: true, maxTokens: 32768, temperature: .1, thinking: { type: "disabled" } });
      save(`model-response-${attempt}.json`, response);
      if (!active || !response.success) throw new Error(`prompt confirmation：正式修订失败 ${response.error ?? "作用域已关闭"}`);
      try { candidate = applyPromptCorrection(reviewedPrompts, response.data ?? JSON.parse(response.content ?? ""), options.metadata); break; }
      catch (error) {
        lastError = error; save(`contract-failure-${attempt}.json`, { error: error instanceof Error ? error.message : String(error) });
        repairFeedback = `\n上一次模型响应不满足确定性输出契约：${error instanceof Error ? error.message : String(error)}。请重新输出完整合法JSON，不能只返回修改片段。上一份响应：${filmCanonicalJson(response.data ?? response.content)}`;
      }
    }
    if (!candidate) throw lastError;
    save("candidate.json", candidate);
    const next = await confirm.call(this, candidate);
    save("verdict.json", next);
    if (!active) throw new Error("PROMPT_REVIEW_BRIDGE_CLOSED");
    if (next.approved) prompts.splice(0, prompts.length, ...candidate);
    return next;
    } finally { clearInterval(heartbeat); }
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
    if (options.reusedPortraits) production.reusedPortraits = snapshot(options.reusedPortraits);
    if (options.prepareFinalCandidate) {
      try { production.formalFilmCandidate = await options.prepareFinalCandidate(production, args[0], args[1], args[2]); }
      catch (error) {
        const rejected = error as { code?: string; verdict?: GateVerdict; candidate?: Obj };
        if (rejected.code !== "FILM_EXPORT_UNVERIFIED" || rejected.verdict?.approved !== false || !rejected.candidate
          || rejected.candidate.exportProvenance?.sourceShotsSha256 !== createHash("sha256").update(filmCanonicalJson(production.shots)).digest("hex")) throw error;
        pendingActualRejection = { verdict: rejected.verdict, candidate: rejected.candidate };
        options.log?.("[prompt-review-bridge] 完整合同的实际G6拒绝反馈给原同阶段模型；不伪造裁决、不重跑上游、不提交渲染");
        const verdict = await this._confirmPrompts(prompts);
        args[2].prompts = verdict;
        if (!verdict.approved) throw error;
        production.shots = prompts.map(shot => snapshot(shot));
        production.formalFilmCandidate = await options.prepareFinalCandidate(production, args[0], args[1], args[2]);
      }
    }
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
  return () => { if (!active) return; active = false; system.create = create; system._confirmPrompts = confirm; system._confirmPreproductionResult = final;
    if (report) system._generatePromptsReport = report; if (finalReport) system._generatePreproductionReport = finalReport; };
}
