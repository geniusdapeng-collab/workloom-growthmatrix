/**
 * video/whiteboard/lineart.ts —— 逐幕线稿（T-2026-0926-0020）
 *
 * 两条来源（上游 SKILL.md 规定"线稿不在仓内生成"，本仓库把它工程化成两条确定性路径）：
 *
 *   A. `seedream`（默认）：复用成片链路的方舟图像接缝（同 ARK_API_KEY / 同一目录条目），
 *      提示词固化为上游「统一出图视觉规范」；默认接收生成素材，受理回执在下载前持久保存。
 *      显式风格检查只报告结果，不会自动修改提示词并再次付费出图。
 *   B. `sketch`：媒资库/本地实拍图 → cv2 素描化（零模型成本，老素材复用，
 *      对应规格 §2.4 路径 B）。
 *
 * 与规格书 §2.4 的一条**实施期修正**：规格书写"路径 A 让模型同时输出 elements 清单 + 大致方位"。
 * 实测方舟 `images/generations` 只回图像 URL，**没有任何结构化 bbox/元素清单**（见
 * `gen/providers.ts#ArkImageProvider.submit`：payload 仅 prompt/size/seed，响应仅取 `data[0].url`）。
 * 因此元素方位不在出图阶段索取，而是出图后由 `lineart_tools.py analyze` 从**像素**反推
 * （连通域 + 确定性聚合），这也让两条路径共用同一套区域来源，标注阶段不再分叉。
 */
import { existsSync, mkdirSync, writeFileSync, lstatSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { GenProvider } from "@workloom/base/model-router";
import { resumeOrSubmitImageTask, readAcceptedImageTask, imageTaskRequestHash } from "@hyperreality/video-studio/image-task-receipt";
import { filmReviewPolicy, type FilmReviewPolicy } from "@hyperreality/video-studio/rendered-output-policy";
import { downloadToMediaStore } from "../gen/ingest.js";
import { getModel, resolveProviderModel } from "../gen/catalog.js";
import { compileProviderRequest, providerEndpointOptions, canonicalRenderJson } from "../gen/compiled-request.js";
import { videoGenPool } from "../gen/providers.js";
import { WhiteboardEngineError, readImageSize, runLineartTool, whiteboardEnv } from "./engine.js";

/** 上游 SKILL.md 的「统一出图视觉规范」逐条固化（禁止改动措辞：风格漂移会直接毁掉系列一致性） */
export const LINEART_STYLE_PROMPT = [
  "极简手绘线稿插画，纯素描草图风格，类似 Notion 的克制涂鸦美学。",
  "暖米黄色旧纸张背景（#F5EBD7），深灰色素描线条（#3A3E46），干净背景、大量留白。",
  "对象以简洁轮廓与少量线条表达，强调关系、变化与核心概念，不追求写实比例与细节。",
  "红、橙、蓝仅允许极少量概念性点缀。",
  "禁止：画面中的任何文字、词语、字母、数字、标签；写实感、摄影细节、3D 效果、绘画质感；",
  "复杂场景、密集背景、繁复装饰、高饱和度配色。",
  "画面主体之间必须互不重叠、彼此留出清晰空隙，便于后续分区绘制。",
].join("");

export interface LineartCheck {
  ok: boolean;
  status?: "skipped" | "measured" | "unverified";
  reviewPolicy?: FilmReviewPolicy;
  accepted?: boolean;
  checks: Array<{ id: string; pass: boolean; detail: string }>;
  metrics: Record<string, unknown>;
}

export interface LineartResult {
  /** 媒体仓相对路径（入库口径，与 video_assets.meta.localPath 对齐） */
  relPath: string;
  absPath: string;
  source: "seedream" | "sketch" | "upload";
  prompt: string | null;
  check: LineartCheck;
  /** 本次付费提交次数；复用已有受理回执为 0 */
  attempts: number;
}

export interface LineartOptions {
  workspaceId: string;
  sceneNo: number;
  jobDir: string;
  /** 这一幕要表达的核心意思（进提示词的"画面内容"位） */
  coreIdea: string;
  /** 这一幕字幕里出现的具体对象/动作（进提示词的"必须出现的元素"位） */
  elements: string[];
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** 跨工作目录的业务项目身份；正式路由的 jobDir 已是稳定的 film-<projectId> 目录。 */
  projectId?: string;
  receiptRoot?: string;
  reviewPolicy?: FilmReviewPolicy;
  /** 适配器与风格检查装配缝（测试可注入；正式路径使用原目录/供应商适配器）。 */
  provider?: Pick<GenProvider, "providerId" | "kind" | "submit">;
  checkImpl?: typeof checkLineart;
}

/** 出图提示词：规范 + 本幕内容 + 本幕元素（元素清单是"看得见什么"的唯一来源） */
export function buildLineartPrompt(coreIdea: string, elements: string[]): string {
  const items = elements.map((e) => e.trim()).filter(Boolean);
  return [
    LINEART_STYLE_PROMPT,
    `画面内容：${coreIdea.trim()}。`,
    items.length > 0 ? `必须出现的元素：${items.join("、")}。` : "",
    "16:9 横向构图，主体居中偏上，四边保留充足留白。",
  ].filter(Boolean).join("\n");
}

/** 风格机检（调 lineart_tools.py check；非 0 退出码代表"不过"，其 JSON 仍要读出来做重出依据） */
export async function checkLineart(absPath: string, env: NodeJS.ProcessEnv = process.env): Promise<LineartCheck> {
  const res = await runLineartTool<{ checks: LineartCheck["checks"]; metrics: Record<string, unknown> }>(
    ["check", "--in", absPath],
    { env, allowNonZero: true, timeoutMs: 120_000 },
  );
  if (!res.ok) {
    // 工具本身报错（读不了图等）：当成"机检不过"，原因带进重出提示词
    return { ok: false, checks: [{ id: "tool", pass: false, detail: res.error }], metrics: {} };
  }
  return { ok: true, checks: res.checks, metrics: res.metrics };
}

/** 路径 A：一次付费受理、持久 URL 回执；故障恢复只重新下载原产物。 */
async function generateSeedream(opts: LineartOptions): Promise<{ bytes: Buffer; prompt: string; attempts: number; check: LineartCheck }> {
  const env = opts.env ?? process.env;
  if (!env.VOLCENGINE_ARK_API_KEY?.trim()) {
    throw new WhiteboardEngineError(
      "Seedream 线稿需要 VOLCENGINE_ARK_API_KEY（ARK_API_KEY 亦可）",
      "要么配置方舟密钥，要么把线稿路径改为 sketch（WHITEBOARD_LINEART=sketch，用媒资库实拍图素描化）",
    );
  }
  const modelId = env.WHITEBOARD_LINEART_MODEL?.trim() || "doubao-seedream-5-0-pro";
  const model = getModel(modelId);
  if (!model) throw new WhiteboardEngineError(`媒体目录中不存在图像模型：${modelId}`);
  if (model.kind !== "image" || model.provider !== "seedream") throw new WhiteboardEngineError("Seedream 线稿路径需要目录中的 Seedream 图像模型");
  const provider = opts.provider ?? videoGenPool(env).get(model.provider);
  if (!provider) {
    throw new WhiteboardEngineError(
      `图像供应商 ${model.provider} 未装配（缺密钥或被禁用）`,
      "检查 provider 装配：gen/providers.ts#buildVideoGenPool",
    );
  }
  if (provider.providerId !== model.provider || provider.kind !== "image") throw new WhiteboardEngineError("线稿供应商与图像目录身份不一致");
  const providerModel = resolveProviderModel(model, env);
  const prompt = buildLineartPrompt(opts.coreIdea, opts.elements);
  const req = { prompt, estimatedUnits: 1, refId: `whiteboard-scene-${opts.sceneNo}`,
    params: { providerModel, resolution: env.WHITEBOARD_LINEART_SIZE?.trim() || "2K" } };
  const endpointOptions = providerEndpointOptions(model.provider, env);
  const compiled = compileProviderRequest(model.provider, req, endpointOptions);
  const root = opts.receiptRoot?.trim() || env.WORKLOOM_GENERATION_RECEIPT_ROOT?.trim() || join(whiteboardEnv(env).jobsDir, "generation-receipts", "images");
  const identity = { projectId: `${opts.workspaceId}:whiteboard:${opts.projectId ?? basename(resolve(opts.jobDir))}`,
    slotId: `scene:${opts.sceneNo}`, provider: compiled.provider, endpoint: compiled.endpoint, body: compiled.body };
  const out = join(opts.jobDir, lineartFileName(opts.sceneNo)), meta = `${out}.generation.json`;
  let legacy = existsSync(out);
  if (legacy && existsSync(meta)) {
    if (lstatSync(meta).isSymbolicLink()) throw new WhiteboardEngineError("线稿受理旁证不能是符号链接");
    const prior = JSON.parse(readFileSync(meta, "utf8")) as { identity: typeof identity; requestHash: string };
    if (prior.requestHash !== imageTaskRequestHash(prior.identity) || prior.identity.projectId !== identity.projectId || prior.identity.slotId !== identity.slotId) throw new WhiteboardEngineError("线稿受理旁证与项目不一致");
    // A known prior acceptance proves which older request produced this slot.
    legacy = readAcceptedImageTask({ root, ...prior.identity }) === null;
  }
  let attempts = 0;
  const accepted = await resumeOrSubmitImageTask({ root, ...identity, requireExisting: legacy,
    submit: async frozenBody => {
      if (canonicalRenderJson(compileProviderRequest(model.provider, req, endpointOptions).body) !== canonicalRenderJson(frozenBody)) throw new WhiteboardEngineError("线稿发送请求与受理身份不同");
      attempts++;
      const { taskId } = await provider.submit(req);
      // Seedream's official adapter embeds its synchronous accepted URL in the ACK.
      // Decode synchronously, then save it before any poll or download.
      if (!taskId.startsWith("sync-url-")) throw new WhiteboardEngineError("Seedream 未返回可持久保存的图像受理URL；禁止重新提交");
      return { url: Buffer.from(taskId.slice("sync-url-".length), "base64url").toString("utf8") };
    } });
  writeLineartFile(meta, Buffer.from(JSON.stringify({ identity, requestHash: imageTaskRequestHash(identity) })));
  const res = await (opts.fetchImpl ?? fetch)(accepted.url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new WhiteboardEngineError(`线稿下载失败：HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length || bytes.length > 100_000_000) throw new WhiteboardEngineError("线稿下载为空或超过存储上限");
  const probe = join(opts.jobDir, `scene-${pad(opts.sceneNo)}.lineart.probe.png`);
  writeLineartFile(probe, bytes);
  const size = readImageSize(probe);
  if (!size || size.width <= 0 || size.height <= 0) throw new WhiteboardEngineError("线稿下载无法读取图像；续跑只恢复原URL");
  const check = await reviewLineart(probe, opts);
  return { bytes, prompt, attempts, check };
}

function writeLineartFile(file: string, bytes: Buffer): void {
  if (lstatSync(dirname(file)).isSymbolicLink() || existsSync(file) && lstatSync(file).isSymbolicLink()) throw new WhiteboardEngineError("线稿输出不能是符号链接");
  const temporary = join(dirname(file), `.lineart-${randomUUID()}.tmp`);
  try { writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 }); renameSync(temporary, file); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

async function reviewLineart(file: string, opts: Pick<LineartOptions, "env" | "reviewPolicy" | "checkImpl">): Promise<LineartCheck> {
  const policy = filmReviewPolicy(opts.reviewPolicy);
  if (policy === "off") return { ok: false, status: "skipped", reviewPolicy: policy, accepted: true, checks: [], metrics: {} };
  let measured: LineartCheck;
  try { measured = await (opts.checkImpl ?? checkLineart)(file, opts.env); }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (policy === "blocking") throw new WhiteboardEngineError("显式线稿风格检查无法执行；已生成素材与回执保留，不自动重新出图", detail);
    return { ok: false, status: "unverified", reviewPolicy: policy, accepted: true,
      checks: [{ id: "tool", pass: false, detail }], metrics: {} };
  }
  if (policy === "blocking" && !measured.ok) throw new WhiteboardEngineError("显式线稿风格检查未通过；已生成素材与受理回执保留，不自动重新出图");
  return { ...measured, status: "measured", reviewPolicy: policy, accepted: true };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * 逐幕线稿（对外唯一入口）。
 *
 * @param sourcePath 路径 B 的输入实拍图（`sketch` 时必填；`upload` 时即该图本身）
 */
export async function buildSceneLineart(
  input: LineartOptions & { mode: "seedream" | "sketch" | "upload"; sourcePath?: string },
): Promise<LineartResult> {
  const env = input.env ?? process.env;
  if (!input.workspaceId.trim() || input.projectId !== undefined && !input.projectId.trim() || !Number.isSafeInteger(input.sceneNo) || input.sceneNo < 1) throw new WhiteboardEngineError("线稿项目或幕号无效");
  filmReviewPolicy(input.reviewPolicy);
  mkdirSync(input.jobDir, { recursive: true });
  if (lstatSync(input.jobDir).isSymbolicLink()) throw new WhiteboardEngineError("线稿工作目录不能是符号链接");
  const name = `scene-${pad(input.sceneNo)}.lineart.png`;
  const outPath = join(input.jobDir, name);

  if (input.mode === "seedream") {
    const { bytes, prompt, attempts, check } = await generateSeedream(input);
    writeLineartFile(outPath, bytes);
    return { relPath: outPath, absPath: outPath, source: "seedream", prompt, check, attempts };
  }

  if (!input.sourcePath) {
    throw new WhiteboardEngineError(
      `线稿路径 ${input.mode} 需要一张输入图（媒资库选图或上传的实拍图）`,
      "在 whiteboard.lineart 调用里显式传 sourcePath，或把 WHITEBOARD_LINEART 改回 seedream",
    );
  }
  if (input.mode === "upload") {
    const buf = (await import("node:fs")).readFileSync(input.sourcePath);
    writeLineartFile(outPath, buf);
  } else {
    const res = await runLineartTool<{ output: string }>(
      ["sketch", "--in", input.sourcePath, "--out", outPath],
      { env, timeoutMs: 300_000 },
    );
    if (!res.ok) throw new WhiteboardEngineError(`素描化失败：${res.error}`);
  }
  if (!existsSync(outPath)) throw new WhiteboardEngineError(`线稿未产出：${outPath}`);
  const size = readImageSize(outPath);
  if (!size || size.width <= 0 || size.height <= 0) throw new WhiteboardEngineError("线稿产物无法读取图像");
  const check = await reviewLineart(outPath, input);
  return { relPath: outPath, absPath: outPath, source: input.mode, prompt: null, check, attempts: 1 };
}

/**
 * 线稿入库媒资库（kind='upload_image'）——白板线稿是可复用资产：
 * 同一条线稿改标注即可重出另一种节奏的片子（上游 SKILL.md 的"预览台调整后重渲"工作流）。
 */
export async function storeLineart(
  absPath: string,
  opts: { workspaceId: string; fetchImpl?: typeof fetch },
): Promise<{ relPath: string; sha256: string; bytes: number }> {
  const size = readImageSize(absPath);
  if (!size) throw new WhiteboardEngineError(`线稿不是可解析的 PNG/JPEG：${absPath}`);
  const stored = await downloadToMediaStore(`file://${absPath}`, {
    workspaceId: opts.workspaceId,
    fetchImpl: opts.fetchImpl,
  });
  return { relPath: stored.relPath, sha256: stored.sha256, bytes: stored.bytes };
}

/** 线稿产物名（排障时按幕号直接找文件） */
export function lineartFileName(sceneNo: number): string {
  return `scene-${pad(sceneNo)}.lineart.png`;
}

/** 线稿检查图的旁证文件名（保留在 job 目录，便于复核机检读数） */
export function lineartProbeName(sceneNo: number): string {
  return basename(`${lineartFileName(sceneNo)}.probe`);
}
