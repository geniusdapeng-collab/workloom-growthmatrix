/** 正式预制作产物到成片入口的导出；模型只补环境/钩子契约，不代写既有剧本或镜头。 */
import { createHash } from "node:crypto";
import type { PreproductionResult, ApprovalCallback } from "./studio.js";
import type { WorkloomLLMEngine } from "./llm-adapter.js";
import { filmCanonicalJson } from "./film-worker-channel.js";
import { environmentDefects, expandShotWithBible, validateSceneBible, type SceneBible } from "./scene-bible.js";
import { openingHookChecks, validateHookCard, type HookCard } from "./opening-hook.js";
import { productHeroPhoto, productPhotoPath, type LoadedProductArchive } from "./product-archive.js";
import { isRealPersonAssetRef } from "./real-person-asset.js";
type Obj = Record<string, any>;
const obj = (value: unknown): Obj => value && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const hash = (value: unknown) => createHash("sha256").update(filmCanonicalJson(value)).digest("hex");
export interface FilmShotlist extends Obj {
  schemaVersion: "workloom.film-shotlist/v1"; projectId: string; shots: Obj[]; durationSeconds: number;
}
function dialogueOf(shot: Obj): Obj[] {
  if (Array.isArray(shot.dialogue)) return structuredClone(shot.dialogue);
  const blocks: Obj[] = Array.isArray(shot.dialogueBlocks) ? shot.dialogueBlocks : [];
  if (!text(shot.dialogue)) return blocks.map((block: Obj) => ({ ...block, text: text(block.text ?? block.line) }));
  if (!shot.dialogue.includes("|")) {
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
    delete mapped.fields; delete mapped.shot_id;
    // 明确角色身份只做引用映射，外观与台词仍来自正式生成物；角色丢失不凭空增补。
    if (cast.id) {
      const noPerson = /^(?:无角色出场|无人物|无人出镜|无角色|无出镜人物)(?:[，,；;。\s].*|$)/.test(mapped.character);
      if (noPerson) { delete mapped.characterId; delete mapped.assetRef; }
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
  if (!Number.isFinite(target) || Math.abs(durationSeconds - target) > .05) throw new Error(`FILM_DURATION_CHANGED：正式分配${durationSeconds}s与目标${target}s不一致`);
  return { schemaVersion: "workloom.film-shotlist/v1", projectId: input.projectId, shots, durationSeconds,
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
  const expanded = next.shots.map(shot => expandShotWithBible(shot, next.sceneBible));
  const defects = environmentDefects(expanded, next.sceneBible).filter(defect => defect.hard);
  const hookChecks = openingHookChecks({ shots: next.shots as any, hook, platform, shortForm: true }).filter(check => check.hard && !check.pass);
  if (defects.length || hookChecks.length) throw new Error(`FILM_ENVIRONMENT_INVALID：${[...defects, ...hookChecks].map(item => item.detail).join("；")}`);
  const firstLines = next.shots[0]!.dialogue.map((line: Obj) => text(line.text)).join("");
  if (!firstLines.includes(hook.firstShotTemplate!.line)) throw new Error("FILM_HOOK_DIALOGUE_CHANGED：钩子首句必须来自正式首镜台词，不能另写口播");
  next.exportProvenance.environmentSha256 = hash(generated);
  return next;
}

export async function exportPreproductionFilm(input: {
  result: PreproductionResult; projectId: string; metadata: Obj; product?: LoadedProductArchive;
  llm: Pick<WorkloomLLMEngine, "reason">; onApproval: ApprovalCallback; onArtifact?: (name: string, value: unknown) => Promise<void> | void;
}): Promise<FilmShotlist> {
  const mapped = mapPreproductionFilm(input);
  const contract = `正式成片导出工位。下面是已生成镜头及完整PRD，不能改台词、时长、动作、人物或商品事实。只输出JSON：
{sceneBible:{spaceId:string,space:{building:string,orientation?:string,timeOfDay?:string},materials:[{item,material,finish?,wear?}],practicalLights:[{type,kelvin?,direction?}],traces:string[],environmentProfile:{setting:'interior'|'exterior'|'studio'|'product',condition:'used'|'new'|'maintained'|'sterile'|'natural'},otherSpaces?:[]},
hook:{type:'question'|'conflict'|'counterintuitive'|'benefit'|'result-first'|'suspense'|'number'|'scene-shock',promise:string,payoffShotId:string,firstShotTemplate:{visual:string,line:string,lineSec:number},sfx:{kind:'impact'|'whoosh'|'riser',atSec:number}},
shots:[{shotId:原镜号,sceneId:所用空间ID,propInteraction?:[{prop,purpose:'operate'|'present'|'shared-view'|'rest',orientation,operatedBy,screenFacing:'operator'|'audience'|'shared'|'away',contact,occlusion?}],environmentProfile?:对象,visibleMaterials?:string[],devices?:[{category,model}]}]}
环境补充是待渲染的创作布景，不冒称实拍记录。各镜维持原设计的空间连续性；可见材质、实际光源与使用状态须具体；不同空间分别列otherSpaces，不能共享错误布景。屏幕道具操作/展示须声明朝向/操作者/接触且符合原动作。设备型号必须与原卡或登记productRef一致，不能自创。钩子首句必须截取正式首镜台词已有的≤18字连续句段（不另写）；兑现镜必须实际存在，不能许诺未获支持的效果。返回每个原镜号恰好一次，不可添加任何其他字段。`;
  const response = await input.llm.reason(`${contract}\n${filmCanonicalJson({ document: mapped, prd: obj(obj(input.result.stages).prdGeneration).data,
    usage: input.metadata.marketingUsage })}`, { forceJson: true, maxTokens: 8192, temperature: .1, thinking: { type: "disabled" } });
  await input.onArtifact?.("film-environment-response.json", response);
  if (!response.success) throw new Error(`FILM_ENVIRONMENT_GENERATION_FAILED：${response.error}`);
  const generated = obj(response.data ?? JSON.parse(response.content ?? ""));
  const document = applyFilmEnvironment(mapped, generated, text(obj(input.metadata.brief).platform));
  await input.onArtifact?.("film-shotlist-candidate.json", document);
  const complete = filmCanonicalJson(document);
  for (const gate of ["G6_PROMPT", "G7_FINAL"]) {
    const verdict = await input.onApproval({ gate, vendorType: "formal-film-export", title: "正式成片导出完整镜头与环境/钩子契约",
      contentMd: complete, runId: null });
    if (!verdict.approved) throw new Error(`FILM_EXPORT_UNVERIFIED：${gate}未批准${verdict.reason ?? ""}`);
  }
  return document;
}
