/** 正式预制作产物到成片入口的导出；模型只补环境/钩子契约，不代写既有剧本或镜头。 */
import { createHash } from "node:crypto";
import type { PreproductionResult, ApprovalCallback } from "./studio.js";
import type { WorkloomLLMEngine } from "./llm-adapter.js";
import { filmCanonicalJson } from "./film-worker-channel.js";
import { environmentDefects, expandShotWithBible, resolveSceneEnvironment, SceneBibleError, validateSceneBible, type SceneBible } from "./scene-bible.js";
import { openingHookChecks, validateHookCard, type HookCard } from "./opening-hook.js";
import { productHeroPhoto, productPhotoPath, type LoadedProductArchive } from "./product-archive.js";
import { isRealPersonAssetRef } from "./real-person-asset.js";
import { auditFilmRedlines } from "./prompt-redlines.js";
import { durationPolicy, FILM_COMPLETENESS_PRINCIPLE } from "./creative-duration-policy.js";
type Obj = Record<string, any>;
const obj = (value: unknown): Obj => value && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const hash = (value: unknown) => createHash("sha256").update(filmCanonicalJson(value)).digest("hex");
export interface FilmShotlist extends Obj {
  schemaVersion: "workloom.film-shotlist/v1"; projectId: string; shots: Obj[]; durationSeconds: number;
}
/** 只恢复实际冻结稿的确定性红线拒绝；不把原G6/G7批准改写成模型拒绝。 */
export function inspectFilmRenderRedlineRejection(exported: FilmShotlist, ready: Obj, marketingFacts: Obj): string {
  if (!marketingFacts || filmCanonicalJson({ ...exported, marketingFacts }) !== filmCanonicalJson(ready)) {
    throw new Error("FILM_RENDER_RESUME_CHANGED：冻结镜头或事实资格不等于原受审导出物");
  }
  const verdict = auditFilmRedlines(exported.shots, { fps: 30 });
  if (!verdict.hard.length) throw new Error("FILM_RENDER_RESUME_NOT_REJECTED：当前冻结稿没有实际渲染红线拒绝");
  return `正式渲染前确定性红线实际拒绝（${verdict.policy}，不是原G6/G7模型裁决）：${verdict.hard.map(issue => `[${issue.id}] ${issue.detail}`).join("；")}`;
}
function dialogueOf(shot: Obj): Obj[] {
  if (Array.isArray(shot.dialogue)) return structuredClone(shot.dialogue);
  if (/^[（(]?无(?:对白|台词)[）)]?[。.]?$/.test(text(shot.dialogue))) return [];
  const blocks: Obj[] = Array.isArray(shot.dialogueBlocks) ? shot.dialogueBlocks : [];
  if (!text(shot.dialogue)) return blocks.map((block: Obj) => ({ ...block, text: text(block.text ?? block.line) }));
  if (!shot.dialogue.includes("|")) {
    if (blocks.length && blocks.map(block => text(block.text ?? block.line)).join("") === text(shot.dialogue)) {
      return blocks.map(block => ({ ...structuredClone(block), text: text(block.text ?? block.line) }));
    }
    // Phase3/3.5 can revise the dialogue field while the prior block text stays
    // unchanged. Keep the actual reviewed field; blocks supply speaker metadata.
    const speakers = [...new Set(blocks.map(block => text(block.speaker)).filter(Boolean))];
    if (speakers.length !== 1) throw new Error("FILM_DIALOGUE_UNSTRUCTURED：本次台词缺少唯一正式说话人");
    const types = [...new Set(blocks.map(block => text(block.type)).filter(Boolean))];
    const emotions = [...new Set(blocks.map(block => text(block.emotion)).filter(Boolean))];
    return [{ speaker: speakers[0], text: text(shot.dialogue),
      ...(types.length === 1 ? { type: types[0] } : {}), ...(emotions.length === 1 ? { emotion: emotions[0] } : {}) }];
  }
  return shot.dialogue.split(/\s*\|\|\s*/).map((line: string) => {
    const parts = line.split("|");
    if (parts.length < 4) throw new Error("FILM_DIALOGUE_UNSTRUCTURED：台词没有正式说话人/类型/情绪/原文结构");
    return { speaker: parts[0], type: parts[1], emotion: parts[2], text: parts.slice(3).filter(part => !/^LIP_SYNC:/.test(part)).join("|") };
  });
}
export function mapPreproductionFilm(input: {
  result: PreproductionResult; projectId: string; metadata: Obj; product?: LoadedProductArchive;
}): FilmShotlist {
  if (input.result.success !== true) throw new Error("FILM_PREPRODUCTION_REQUIRED：只导出正式成功产物");
  const stages = obj(input.result.stages), production = obj(stages.productionEngine), prd = obj(obj(stages.prdGeneration).data);
  if (!Array.isArray(production.shots) || !production.shots.length) throw new Error("FILM_SHOTS_REQUIRED");
  if (obj(stages.prdGeneration).degraded) throw new Error("FILM_PRD_UNVERIFIED：PRD曾降级，不能导出未审兜底稿");
  return mapFormalProduction({ ...input, production, prd });
}
function mapFormalProduction(input: { production: Obj; prd: Obj; projectId: string; metadata: Obj; product?: LoadedProductArchive }): FilmShotlist {
  const { production, prd } = input;
  if (!Array.isArray(production.shots) || !production.shots.length) throw new Error("FILM_SHOTS_REQUIRED");
  const cast = obj(input.metadata.characterArchive), brief = obj(input.metadata.brief);
  const assetRef = text(obj(cast.authorization).evidence);
  if (cast.id && !isRealPersonAssetRef(assetRef)) throw new Error("FILM_CAST_ASSET_REQUIRED：明确真人档案缺平台引用");
  const product = input.product;
  if (product?.issues.some(issue => issue.hard)) throw new Error("FILM_PRODUCT_INVALID：商品档案未通过资产校验");
  const hero = product ? productHeroPhoto(product.archive) : null;
  const shots = production.shots.map((raw: Obj) => {
    const flat = { ...structuredClone(raw), ...structuredClone(obj(raw.fields)) };
    const shotId = text(raw.shotId ?? raw.shot_id ?? flat.shotId ?? flat.shot_id);
    const duration = Number(raw.duration ?? flat.duration ?? obj(flat.timing).duration);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(shotId) || shotId.includes("..") || !Number.isFinite(duration) || duration <= 0) throw new Error("FILM_SHOT_INVALID");
    const prompt = text(raw.prompt ?? flat.prompt);
    if (prompt.length < 1200) throw new Error(`FILM_PROMPT_INCOMPLETE：${shotId}正式提示词不足1200字`);
    for (const key of ["scene", "action", "character"]) if (!text(flat[key])) throw new Error(`FILM_FIELD_REQUIRED：${shotId}.${key}`);
    const mapped: Obj = { ...flat, shotId, duration, prompt, dialogue: dialogueOf(flat) };
    const speechRate = Number.parseFloat(String(cast.persona?.speechRate ?? "3.2"));
    const speechChars = mapped.dialogue.map((block: Obj) => text(block.text)).join("").replace(/[\s\p{P}\p{S}]/gu, "").length;
    if (!Number.isFinite(speechRate) || speechRate <= 0 || speechChars > Math.floor(Math.max(0, duration - .4) * speechRate)) {
      throw new Error(`FILM_DIALOGUE_DURATION_INVALID：${shotId}台词${speechChars}字超出正式${duration}s口播预算`);
    }
    delete mapped.fields; delete mapped.shot_id;
    // 明确角色身份只做引用映射，外观与台词仍来自正式生成物；角色丢失不凭空增补。
    if (cast.id) {
      const noPerson = /^(?:无角色出场|无人物|无人出镜|无角色|无出镜人物)(?:[，,；;。\s].*|$)/.test(mapped.character);
      if (noPerson) {
        const subject = obj(mapped.subject);
        if (subject.hasPerson === true || Number(subject.count) > 0 || subject.faceVisible === true || /^(?:person|human)$/i.test(text(subject.kind))) {
          throw new Error(`FILM_SUBJECT_CONFLICT：${shotId}明确无人但主体声明有人`);
        }
        mapped.subject = { ...subject, hasPerson: false, count: 0, faceVisible: false };
        delete mapped.characterId; delete mapped.assetRef;
      }
      else {
        if (![cast.id, cast.name].filter(Boolean).some(name => mapped.character.includes(String(name)))) throw new Error(`FILM_CAST_CHANGED：${shotId}未包含明确角色`);
        mapped.characterId = cast.id; mapped.assetRef = assetRef;
      }
    }
    if (product && hero) {
      mapped.productRef = product.archive.id; mapped.photo = productPhotoPath(product, hero);
      mapped.materialUsage = "generation-reference";
      mapped.materialDescription = `本次登记的${product.archive.id}产品参考图；外观只按图核对，不添加未经本次G1支持的参数或品牌事实`;
      mapped.productPhotoSha256 = hero.sha256;
    }
    return mapped;
  });
  if (cast.id && !shots.some((shot: Obj) => shot.characterId === cast.id)) throw new Error("FILM_CAST_CHANGED：全片没有明确主要人物出镜");
  if (new Set(shots.map((shot: Obj) => shot.shotId)).size !== shots.length) throw new Error("FILM_SHOT_DUPLICATE");
  const durationSeconds = shots.reduce((sum: number, shot: Obj) => sum + shot.duration, 0);
  const target = Number(brief.duration ?? brief.durationSec ?? prd.productPositioning?.targetDuration);
  const policy = durationPolicy(brief.durationPolicy);
  if (!Number.isFinite(target) || target <= 0) throw new Error("FILM_DURATION_TARGET_INVALID");
  if (policy === "strict" && Math.abs(durationSeconds - target) > .05) throw new Error(`FILM_DURATION_CHANGED：strict正式分配${durationSeconds}s与目标${target}s不一致`);
  return { schemaVersion: "workloom.film-shotlist/v1", projectId: input.projectId, shots, durationSeconds,
    durationPolicy: policy, targetDurationSeconds: target, completenessPrinciple: FILM_COMPLETENESS_PRINCIPLE,
    title: text(prd.projectDefinition?.projectName), aspect: brief.aspectRatio ?? prd.productPositioning?.aspectRatio,
    resolution: brief.resolution ?? prd.productPositioning?.resolution, videoType: "商业广告",
    pipeline: obj(input.metadata.pipelineRoute).kind ?? "narrative",
    character: cast.id ? { id: cast.id, name: cast.name } : null,
    exportProvenance: { source: "formal-preproduction", sourceShotsSha256: hash(production.shots), sourcePrdSha256: hash(prd),
      note: "既有镜头/台词/提示词从正式生成物忠实映射；场景圣经与钩子另由正式模型补全并重新送审" } };
}

/** 只允许补环境与已有台词的钩子索引；不允许重新写人物、动作、台词、产品事实或时长。 */
export function applyFilmEnvironment(document: FilmShotlist, generated: Obj, platform: string): FilmShotlist {
  const bibleIssues = validateSceneBible(generated.sceneBible);
  if (bibleIssues.length) throw new Error(`FILM_ENVIRONMENT_INVALID：${bibleIssues.join("；")}`);
  const hook = generated.hook as HookCard;
  const hookIssues = hook && validateHookCard(hook);
  if (!hook || hookIssues!.length) throw new Error(`FILM_HOOK_INVALID：${hookIssues?.join("；") ?? "缺钩子"}`);
  if (!Array.isArray(generated.shots) || generated.shots.length !== document.shots.length
    || new Set(generated.shots.map((s: Obj) => s.shotId)).size !== document.shots.length) throw new Error("FILM_ENVIRONMENT_SCOPE_CHANGED");
  const allowed = new Set(["shotId", "sceneId", "propInteraction", "environmentProfile", "visibleMaterials", "devices"]);
  const scenes = new Map(generated.shots.map((shot: Obj) => {
    if (!document.shots.some(original => original.shotId === shot.shotId) || Object.keys(shot).some(key => !allowed.has(key))) throw new Error("FILM_ENVIRONMENT_SCOPE_CHANGED：禁止新增镜头或改写既有创意字段");
    return [shot.shotId, shot];
  }));
  const next = structuredClone(document);
  next.sceneBible = generated.sceneBible as SceneBible; next.hook = hook;
  next.shots = document.shots.map(shot => ({ ...structuredClone(shot), ...structuredClone(scenes.get(shot.shotId)) }));
  const contractErrors: string[] = [];
  const expanded = next.shots.flatMap(shot => {
    try { return [expandShotWithBible(shot, next.sceneBible)]; }
    catch (error) {
      if (!(error instanceof SceneBibleError)) throw error;
      let detail = `${shot.shotId}：${error.message}`;
      if (error.code === "SCENE_VISIBILITY_INVALID") {
        detail += `；本镜visibleMaterials=${filmCanonicalJson(shot.visibleMaterials)}；本空间已登记item=${filmCanonicalJson(resolveSceneEnvironment(next.sceneBible, shot.sceneId).materials.map(item => item.item))}`;
      }
      contractErrors.push(detail); return [];
    }
  });
  const defects = environmentDefects(expanded, next.sceneBible).filter(defect => defect.hard);
  const hookChecks = openingHookChecks({ shots: next.shots as any, hook, platform, shortForm: true }).filter(check => check.hard && !check.pass);
  const first = next.shots[0]!, firstLines = first.dialogue.map((line: Obj) => text(line.text)).join("");
  const hookLine = hook.firstShotTemplate!.line;
  if (firstLines && !firstLines.includes(hookLine)) contractErrors.push(`FILM_HOOK_DIALOGUE_CHANGED：钩子line=${filmCanonicalJson(hookLine)}不在实际首镜${first.shotId}口播${filmCanonicalJson(firstLines)}中，不能引用其他镜台词`);
  if (contractErrors.length || defects.length || hookChecks.length) throw new Error(`FILM_ENVIRONMENT_INVALID：${[...contractErrors, ...[...defects, ...hookChecks].map(item => item.detail)].join("；")}`);
  if (!firstLines.includes(hookLine)) {
    const sourceField = ["subtitle_content", "title_content"].find(key => !firstLines && text(first[key]).includes(hookLine));
    if (!sourceField) throw new Error("FILM_HOOK_DIALOGUE_CHANGED：钩子首句必须来自正式首镜对白或已生成片头旁挂计划，不能另写口播");
    if (hook.firstShotTemplate?.lineSec !== Math.min(Number(first.duration), 3)) throw new Error("FILM_HOOK_CAPTION_TIMING_CHANGED：旁挂钩子窗口必须与首句合同一致");
    next.openingCaption = { shotId: first.shotId, text: hookLine, sourceField, startSec: 0,
      endSec: Math.min(Number(first.duration), 3), delivery: "sidecar-only" };
    verifyOpeningCaption(next);
  }
  next.exportProvenance.environmentSha256 = hash(generated);
  next.exportProvenance.environmentContract = structuredClone(generated);
  return next;
}

export function verifyOpeningCaption(document: Obj): { shotId: string; text: string; startSec: number; endSec: number; sourceField: string; delivery: string } | null {
  const caption = document.openingCaption;
  if (caption === undefined) return null;
  const first = document.shots?.[0];
  if (!caption || typeof caption !== "object" || Array.isArray(caption) || !first || caption.shotId !== first.shotId
    || caption.delivery !== "sidecar-only" || !["subtitle_content", "title_content"].includes(caption.sourceField)
    || typeof caption.text !== "string" || !caption.text.trim() || caption.text.length > 18
    || !text(first[caption.sourceField]).includes(caption.text) || document.hook?.firstShotTemplate?.line !== caption.text
    || document.hook?.firstShotTemplate?.lineSec !== caption.endSec
    || (first.dialogue ?? []).some((line: Obj) => text(line.text)) || caption.startSec !== 0
    || !Number.isFinite(caption.endSec) || caption.endSec <= 0 || caption.endSec > Math.min(Number(first.duration), 3)) {
    throw new Error("FILM_OPENING_CAPTION_CHANGED：旁挂首句不等于正式首镜片头计划/时间窗或混入新口播");
  }
  return caption;
}

async function generateFilmEnvironment(mapped: FilmShotlist, input: {
  prd: Obj; metadata: Obj; llm: Pick<WorkloomLLMEngine, "reason">; onArtifact?: (name: string, value: unknown) => Promise<void> | void;
  factRejection?: string;
}): Promise<FilmShotlist> {
  const contract = `正式成片导出工位。下面是已生成镜头及完整PRD，不能改台词、时长、动作、人物或商品事实。只输出JSON：
{sceneBible:{spaceId:string,space:{building:string,orientation?:string,timeOfDay?:string},materials:[{item,material,finish?,wear?}],practicalLights:[{type,kelvin?,direction?}],traces:string[],environmentProfile:{setting:'interior'|'exterior'|'studio'|'product',condition:'used'|'new'|'maintained'|'sterile'|'natural'},otherSpaces?:[]},
hook:{type:'question'|'conflict'|'counterintuitive'|'benefit'|'result-first'|'suspense'|'number'|'scene-shock',promise:string,payoffShotId:string,firstShotTemplate:{visual:string,line:string,lineSec:number},sfx:{kind:'impact'|'whoosh'|'riser',atSec:number}},
shots:[{shotId:原镜号,sceneId:所用空间ID,propInteraction?:[{prop,purpose:'operate'|'present'|'shared-view'|'rest',orientation,operatedBy,screenFacing:'operator'|'audience'|'shared'|'away',contact,occlusion?}],environmentProfile?:对象,visibleMaterials?:string[],devices?:[{category,model}]}]}
环境补充是待渲染的创作布景，不冒称实拍记录。各镜维持原设计的空间连续性；可见材质、实际光源与使用状态须具体；不同空间分别列otherSpaces，不能共享错误布景。屏幕道具操作/展示须声明朝向/操作者/接触且符合原动作。设备型号必须与原卡或登记productRef一致，不能自创。
当前document是实际修订后的完整镜头设计，优先于较早PRD的布景模板。sceneBible只登记document.scene/props/lighting已有的可见物件与光源；不得新增原镜没有的柔光箱、射灯、百叶窗、金属收边、产品脚垫或物理结构。材质/产品颜色只从当前实际镜头已有描述提取，不根据类别或旧PRD猜测。逐镜引用不同可见子集，但光源类型/方向/色温与当前lighting完全一致，绝不把旧拒绝内容重新填回。
environmentProfile恰好两个键setting和condition。condition选择一个枚举字符串；例如{"setting":"interior","condition":"used"}，不能增加maintained等第三个键。visibleMaterials每一项必须逐字等于当前sceneId的materials数组中某项item，不能写材质描述或未登记物件；需要可见物件就先在materials登记它。otherSpaces内的对象直接放spaceId/building/orientation/timeOfDay/materials/practicalLights/traces/environmentProfile，不额外嵌套space。
devices仅原卡已有设备年代策略声明时原样保留，否则空数组；本次产品由productRef、产品原图及G1事实约束，不能把DEMO-T001塞入消费电子设备年代目录或编造型号类别。propInteraction仍完整核对实际产品展示、操作者、朝向和接触。
propInteraction中的purpose与screenFacing按真实镜头用途填写：屏幕朝向镜头/观众时为present与audience，即使CEO站在旁边指示也不是shared-view。只有原动作明确双方共同观看屏幕时才用shared-view与shared，orientation同时明确双方可见；不能一边写朝向镜头一边写shared。无屏幕道具仍按实际接触与承重描述，不编造功能。
钩子首句必须截取正式首镜台词已有的≤18字连续句段；首镜无对白时只能截取首镜已有subtitle_content或title_content，作为正式后期旁挂字幕，不新增口播或往干净母版绘字。兑现镜必须实际存在，不能许诺未获支持的效果。返回每个原镜号恰好一次，不可添加任何其他字段。`;
  const hookContract = "\n钩子promise必须忠实复述首镜实际景别和动作，远景不能称特写，静态光源不能称一秒扫动；不要添加未出现在原设计的动作。首镜无对白时lineSec必须等于min(首镜duration,3)，它是旁挂字幕在场窗口而非口播时长。";
  let feedback = "", lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await input.llm.reason(`${contract}${hookContract}\n${filmCanonicalJson({ document: mapped, prd: input.prd, usage: input.metadata.marketingUsage,
      actualFinalFactRejection: input.factRejection ?? null })}${feedback}`,
      { forceJson: true, maxTokens: 65536, temperature: .1,
        systemPrompt: "你是正式环境与钩子补全工位。仅返回完整JSON对象，顶层恰好sceneBible/hook/shots；绝不能返回response_format的type:json_object。当前document是已受审镜头，旧PRD与上次错误响应不能覆盖它。保持台词、动作、人物和时长不变。先登记场景materials的完整item名称，再逐镜从同一sceneId的item逐字选visibleMaterials，不写近义名称。首句钩子line只从首镜实际对白截取，不能引用其他镜台词；不增加商品物理结构、功能或布景。环境合同必须具体遵循当前镜头实际台面与承重，台式产品不能改为落地机器。" });
    await input.onArtifact?.(`film-environment-response-${attempt}.json`, response);
    if (!response.success) {
      lastError = new Error(`FILM_ENVIRONMENT_GENERATION_FAILED：${response.error}`);
      await input.onArtifact?.(`film-environment-generation-failure-${attempt}.json`, { error: (lastError as Error).message, retryable: response.retryable === true });
      if (response.retryable === true && attempt < 2) {
        feedback = `\n上次外部模型输出失败：${response.error ?? "没有有效完整响应"}。失败响应已落盘，未成为候选。请从头返回满足原合同的完整json对象，只含sceneBible/hook/shots，不续写局部片段，不改原镜台词、人物、动作或时长。`;
        continue;
      }
      throw lastError;
    }
    try { return applyFilmEnvironment(mapped, obj(response.data ?? JSON.parse(response.content ?? "")), text(obj(input.metadata.brief).platform)); }
    catch (error) {
      lastError = error; await input.onArtifact?.(`film-environment-contract-failure-${attempt}.json`, { error: error instanceof Error ? error.message : String(error) });
      feedback = `\n上次响应未满足确定性合同：${error instanceof Error ? error.message : String(error)}。保持原镜头完全不变，修正矛盾字段后重新输出完整环境/钩子JSON。上次实际响应：${filmCanonicalJson(response.data ?? response.content)}`;
    }
  }
  throw lastError;
}

/** G6已审后、原G7收口前的正式补全；不伪造overall success，不提交渲染。 */
export async function preparePreproductionFilmCandidate(input: {
  production: Obj; confirmations: Obj; projectId: string; metadata: Obj; product?: LoadedProductArchive;
  llm: Pick<WorkloomLLMEngine, "reason">; onApproval: ApprovalCallback; onArtifact?: (name: string, value: unknown) => Promise<void> | void;
  factRejection?: string;
}): Promise<FilmShotlist> {
  if (input.confirmations.prompts?.approved !== true || input.confirmations.prd?.approved !== true || !input.confirmations.prd.prd
    || hash(input.production.shots) !== hash(input.production.prompts)) throw new Error("FILM_CANDIDATE_UNVERIFIED：需本次原G4/G6真实批准且当前镜头/提示词一致");
  const mapped = mapFormalProduction({ ...input, prd: input.confirmations.prd.prd });
  const redlines = auditFilmRedlines(mapped.shots, { fps: 30 });
  if (redlines.hard.length) {
    const reason = `渲染前确定性红线拒绝：${redlines.hard.map(issue => `[${issue.id}] ${issue.detail}`).join("；")}`;
    await input.onArtifact?.("film-redline-rejection.json", { policy: redlines.policy, candidate: mapped, redlines });
    throw Object.assign(new Error(`FILM_EXPORT_UNVERIFIED：${reason}`), { code: "FILM_EXPORT_UNVERIFIED", candidate: mapped,
      verdict: { approved: false, reason, via: "deterministic" } });
  }
  const document = await generateFilmEnvironment(mapped, { ...input, prd: input.confirmations.prd.prd });
  await input.onArtifact?.("film-shotlist-candidate.json", document);
  const verdict = await input.onApproval({ gate: "G6_PROMPT", vendorType: "formal-film-export", title: "正式完整镜头与环境/钩子合同",
    contentMd: filmCanonicalJson(document), runId: null });
  if (!verdict.approved) throw Object.assign(new Error(`FILM_EXPORT_UNVERIFIED：补全合同未获得原G6批准${verdict.reason ?? ""}`),
    { code: "FILM_EXPORT_UNVERIFIED", candidate: document, verdict });
  document.exportProvenance.environmentReview = verdict;
  return document;
}

export async function exportPreproductionFilm(input: {
  result: PreproductionResult; projectId: string; metadata: Obj; product?: LoadedProductArchive;
  llm: Pick<WorkloomLLMEngine, "reason">; onApproval: ApprovalCallback; onArtifact?: (name: string, value: unknown) => Promise<void> | void;
}): Promise<FilmShotlist> {
  const mapped = mapPreproductionFilm(input);
  const prepared = obj(obj(input.result.stages).productionEngine).formalFilmCandidate;
  if (prepared) {
    if (prepared.exportProvenance?.sourceShotsSha256 !== mapped.exportProvenance.sourceShotsSha256
      || prepared.exportProvenance?.sourcePrdSha256 !== mapped.exportProvenance.sourcePrdSha256
      || prepared.exportProvenance?.environmentReview?.approved !== true
      || obj(input.result.confirmations).preproduction?.approved !== true) throw new Error("FILM_EXPORT_CHANGED：原G7受审完整合同与实际源不同");
    const regenerated = applyFilmEnvironment(mapped, prepared.exportProvenance.environmentContract, text(obj(input.metadata.brief).platform));
    regenerated.exportProvenance.environmentReview = structuredClone(prepared.exportProvenance.environmentReview);
    if (filmCanonicalJson(regenerated) !== filmCanonicalJson(prepared)) throw new Error("FILM_EXPORT_CHANGED：导出完整合同不等于实际源与受审环境合同");
    verifyOpeningCaption(prepared); return structuredClone(prepared);
  }
  const document = await generateFilmEnvironment(mapped, { ...input, prd: obj(obj(input.result.stages).prdGeneration).data });
  await input.onArtifact?.("film-shotlist-candidate.json", document);
  const complete = filmCanonicalJson(document);
  for (const gate of ["G6_PROMPT", "G7_FINAL"]) {
    const verdict = await input.onApproval({ gate, vendorType: "formal-film-export", title: "正式成片导出完整镜头与环境/钩子契约",
      contentMd: complete, runId: null });
    if (!verdict.approved) throw new Error(`FILM_EXPORT_UNVERIFIED：${gate}未批准${verdict.reason ?? ""}`);
  }
  return document;
}
