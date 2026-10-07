#!/usr/bin/env tsx
/**
 * full-chain-film.mts —— 全链路出片（AI 监制自动放行版，T-2026-0924-0001）
 *
 * 与 `render-project.mts` 的分工：
 *   · render-project.mts 是"预生产产物 → 逐镜提交渲染"的服务端工具（依赖 server + DB + G8 审批）；
 *   · 本工具是**端到端制片**：脚本 → 提示词交付闸 → 关键帧 → 逐镜视频 → 合成 → 调色 → 字幕
 *     → 弹幕 → 配乐 → 封面 → 母版，新生成前遵循提交要求；已成功生成的片段直接进入正式后期，
 *     不做身份、服装、画面、运动、对白、口型或声音质量复评，并把"这一步到底有没有被调用/有没有降级"写进阶段日志。
 *
 * 用法：
 *   tsx scripts/tools/full-chain-film.mts \
 *     --shots <shotlist.json> --project VID-PJL01 \
 *     --library <角色档案库根> --work-dir <.vm-work 根> --out <交付目录> \
 *     [--stages spec,plates,videos,compose,color,subtitle,danmaku,bgm,cover,mux] \
 *     [--subtitle-mode sidecar|burn|both]   # 缺省 sidecar：字幕只做旁挂文件 + 软字幕轨，母版不烧字 \
 *     [--aspect 9:16|16:9|1:1|4:5] [--resolution 720p|1080p|2160p] [--quality hd|uhd] \
 *     [--enhance-kind live-action|animation] [--enhance-engine-dir <本地引擎目录>] \
 *     [--fps 30] [--max-attempts 1] \
 *     [--duration-policy creative-target|strict] [--post-review off|advisory|blocking] \
 *     [--generation-receipt-root <稳定私有回执目录>] [--legacy-video-receipt-roots <旧目录,旧目录>] \
 *     [--keys-file ~/.workloom/live.env] [--brief <brief.json>] [--no-resume] [--dry-run]
 *
 * 封面平台化与知识库（2026-09-27）：
 *   [--cover-platform douyin|kuaishou|xiaohongshu|wechat-channels|bilibili|tiktok|youtube|instagram-reels]
 *                                 # 缺省沿用 --platform（历史默认"抖音/快手"→抖音口径，回归基线）
 *   [--theme 知识科普|美食|旅行风光|…]   # 缺省从片名 + brief.goal 启发式匹配（匹配不到不注入）
 *   [--account chen-zhuo]           # 账号视觉锤档案（bundles/ai-video/library/account-profiles/<id>.yml）
 *   [--no-cover-kb]                 # 关闭封面知识库注入（退化为平台化之前的设计提示词）
 *
 * 阶段日志：`<work-dir>/logs/stages.jsonl`（逐条：stage/shotId/invoked/ok/degraded/cached/verdict）
 * 阶段汇总：`<work-dir>/logs/stages.json`
 */
import { execFileSync, spawnSync } from "node:child_process";
import { resumeOrSubmitVideoTask, videoTaskReceiptPath, assertVideoTaskReceiptIdentity } from "../../packages/video-studio/src/video-task-receipt.js";
import { prependFilmCover, shiftFilmSubtitleDirectory } from "./film-cover-intro.js";
import { resumeOrSubmitImageTask } from "../../packages/video-studio/src/image-task-receipt.js";
import { filmGenerationReceiptRoots, hasPriorFilmGeneration } from "../../packages/video-studio/src/film-generation-receipts.js";
import { assertPreservedSourceTiming, editorialShotIds, endCardSeconds, parseBgmTargetLufs, parseClipTailHolds, shouldBurnOpeningTitle } from "../../packages/video-studio/src/film-post-options.js";
import { readFilmPresentation, verifyPresentationAsset } from "../../packages/video-studio/src/film-presentation.js";
import { DELIVERY_VARIANTS } from "../../packages/video-studio/src/deliver.js";
import { loadModelDurationLimits } from "../../packages/video-studio/src/duration-rules.js";
import { durationPolicy, FILM_COMPLETENESS_PRINCIPLE, observeFilmDuration, renderSecondsWithinCapability } from "../../packages/video-studio/src/creative-duration-policy.js";
import { executeSurfaceRepair, inspectSurfaceRepair } from "../../packages/video-studio/src/video-surface-repair.js";
import { buildRenderReferences } from "../../packages/video-studio/src/render-reference.js";
import { verifyMarketingFacts, type MarketingScope } from "../../apps/server/src/video/marketing-authority.js";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync, appendFileSync, closeSync, constants as fsConstants, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import YAML from "yaml";
import { filmReviewContracts, loadOrCreateFilmAuthorContext, reviewFilmStage } from "../../packages/video-studio/src/film-contracts.js";
import { buildProducerReviewContract, type ProducerGateOptions } from "../../packages/video-studio/src/producer-gate.js";
import { assessPortraitDecision, selectPortraitDecisionRecord } from "../../packages/video-studio/src/portrait-decision.js";
import { executeRevision } from "../../packages/video-studio/src/revision-executor.js";
import { assessVoiceArtifact, fingerprintFile, fingerprintText, promoteDubCandidate, type VoiceArtifactRecord } from "./film-voice-artifact.js";
import {
  assertSelectedShotStageScope, captureLineageInputs, createLineageReceipt, fingerprintArtifact, latestLineageRecord, productionHash,
  reusableLineageArtifact, stageLineageApproved, verifyLineageReceipt,
  type LineageReceipt, type LineageInputSnapshot,
} from "../../packages/video-studio/src/production-lineage.js";
import {
  applyMicromotion, auditContinuity, buildDeliveryManifest, buildGateEvent,
  motionPolicyForShot, buildCoverDesignPrompt, buildMaterialMotionPrompt, buildPlatePrompt, buildRevisionPlan, buildRevisionReport, buildVariantPlan,
  buildMaterialScenePrompt, decidePlateCache, plateRequestSha256, MATERIAL_MOTION_POLICY, MATERIAL_RAW_MOTION_POLICY, MATERIAL_SCENE_POLICY_VERSION,
  isDoubledNarration, speechAcceptance,
  termPronunciationCheck,
  REFERENCE_INDEPENDENCE_POLICY,
  coverDeterministicChecks, coverPrefersNightBackground, COVER_FONTS, COVER_LOWER_BAND_SAFE_AREA, COVER_REVIEW_RUBRIC, COVER_SAFE_AREA,
  getCoverSpec, isKnownCoverPlatform, COVER_PLATFORM_IDS,
  fallbackCoverPlan, findAngleFile, MATERIAL_POLICY_STATEMENT, MATERIAL_POLICY_VERSION,
  assertMaterialGenerationProvenance, parseCoverPlan, prepareShotPrompt, readMaterialSpec, resolveProducerLlm,
  detectProductAnchor, resolveRoutePreflight, RoutePreflightError, type RoutePreflightResult,
  buildSfxArgs, cutTimesFromShots, planCutSfxDetailed, CUT_SFX_POLICY, planHookSfx, HOOK_SFX_POLICY,
  checkShotOrder, auditDeliverableNaming,
  assessCharacterConsistency, medianColor, type CharacterConsistencyReport, type RgbColor,
  normalizePromptLanguage,
  normalizeDialogueWindow,
  restoreCardFieldText,
  mergeUniqueSegments,
  restoreTimelineField,
  environmentDefects, expandShotWithBible, summarizeDefects, validateSceneBible, spaceSummary,
  applyScenePolicy, auditScenePolicy, loadScenePolicies, selectScenePolicy, PRODUCER_RUBRICS,
  openingHookChecks, summarizeHookChecks, validateHookCard, defaultHookSfx, hookWindowFor, HOOK_TYPE_LABELS, HOOK_WINDOW_SEC,
  checkSpeechFit, speechRateProfile,
  deviceDefects, summarizeDeviceDefects, DEVICE_POLICY_VERSION, DEVICE_POLICY_VERIFIED_AT, allowedModelSummary,
  planMicromotion, MICROMOTION_MARKER, MICROMOTION_POLICY_VERSION,
  type CoverAccountProfile, type CoverDesignInput, type CoverMeasurements, type CoverPlan,
  type CoverPlatformSpec, type GateCheck, type GateEvent, type PipelineGateStepKey,
  type DeviceCategory, type DeviceDefect, type EnvDefect, type HookCard, type MicromotionTrace, type PlatePromptShot,
  type ProducerVerdict, type SceneBible, type ScenePolicyReport
} from "../../packages/video-studio/src/index.js";
import { normalizeShotIntent, shotIntentHash, type ShotIntentStatus } from "../../packages/video-studio/src/shot-intent.js";
import { acceptPostStage, findProviderClip, inspectPostInput, postAcceptanceVerdict, POST_RENDER_ACCEPTANCE_POLICY, POST_RENDER_STAGES, readProviderReceipt } from "../../packages/video-studio/src/post-render-acceptance.js";
import { loadProductArchive, loadProductArchives, productArchivePromptLines, productHeroPhoto, productPhotoPath, selectProductArchive } from "../../packages/video-studio/src/product-archive.js";
import { assertShotMatchesCertifiedAsset, assetIdOf, hasIdentityAnchor, isRealPersonAssetRef, identityAnchorContext, identityAnchorPath, identityReviewContext, loadRealPersonAssets, realPersonUsageReceipt, referenceAssetRefs, REAL_PERSON_POLICY_VERSION } from "../../packages/video-studio/src/real-person-asset.js";
import { auditFilmRedlines, PROMPT_REDLINE_POLICY_VERSION } from "../../packages/video-studio/src/prompt-redlines.js";
import { assessFilmFirstPass, FIRST_PASS_POLICY_VERSION } from "../../packages/video-studio/src/first-pass.js";
import { publishUhdDelivery, sha256UhdAsset } from "../../packages/video-studio/src/uhd-delivery.js";
import { FullChainFilmWorker } from "../../packages/video-studio/src/film-worker-runtime.js";
import { verifyOpeningCaption } from "../../packages/video-studio/src/film-shotlist.js";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const WORKER_RUNTIME = process.argv.includes("--worker") || process.env.FILM_WORKER_MODE === "worker"
  ? FullChainFilmWorker.fromEnvironment(REPO_ROOT) : null;
if (WORKER_RUNTIME) process.argv = [...process.argv.slice(0, 2), ...WORKER_RUNTIME.args];
/** GUI 启动时 PATH 常不含工位 kit；只选经过仓内 pin 摘要核验的本机二进制。 */
function verifiedLocalMediaBins(): { ffmpeg: string; ffprobe: string } | null {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) return null;
  const dir = join(process.env.WORKLOOM_COLOR_HOME || join(homedir(), ".workloom-color"), "bin");
  const paths = { ffmpeg: join(dir, "ffmpeg"), ffprobe: join(dir, "ffprobe") };
  if (!existsSync(paths.ffmpeg) && !existsSync(paths.ffprobe)) return null;
  const pinFile = join(REPO_ROOT, "bundles/ai-video/connectors/color-bridge/kit/ffmpeg-pin.json");
  if (!existsSync(pinFile)) throw new Error(`本机媒体工具已存在，但缺少摘要清单：${pinFile}`);
  const pin = JSON.parse(readFileSync(pinFile, "utf8")) as {
    targets?: Record<string, Record<string, { sha256?: string }>>;
  };
  const target = pin.targets?.[`darwin-${process.arch}`];
  for (const [name, file] of Object.entries(paths)) {
    const expected = target?.[name]?.sha256;
    if (!expected || !/^[a-f0-9]{64}$/i.test(expected)) {
      throw new Error(`本机媒体工具 ${name} 没有该平台的受控 SHA-256；请先检查 kit pin`);
    }
    try { accessSync(file, fsConstants.X_OK); }
    catch { throw new Error(`本机媒体工具不可执行或缺失：${file}`); }
    const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
    if (actual !== expected) throw new Error(`本机媒体工具摘要不匹配：${file}`);
  }
  return paths;
}
const EXPLICIT_FFMPEG = process.env.WL_FFMPEG || process.env.FFMPEG_PATH;
const EXPLICIT_FFPROBE = process.env.WL_FFPROBE || process.env.FFPROBE_PATH;
const LOCAL_MEDIA_BINS = EXPLICIT_FFMPEG && EXPLICIT_FFPROBE ? null : verifiedLocalMediaBins();
const FFMPEG = EXPLICIT_FFMPEG || LOCAL_MEDIA_BINS?.ffmpeg || "ffmpeg";
const FFPROBE = EXPLICIT_FFPROBE || LOCAL_MEDIA_BINS?.ffprobe || "ffprobe";
process.env.WL_FFMPEG ||= FFMPEG;
process.env.WL_FFPROBE ||= FFPROBE;

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
const flag = (name: string) => process.argv.includes(name);
const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));
const stamp = () => new Date().toISOString();
const log = (line: string): void => { process.stdout.write(`[${stamp().slice(11, 19)}] ${line}\n`); };

/* ================= 参数 ================= */

const SHOTS_FILE = abs(arg("--shots"));
if (!SHOTS_FILE || !existsSync(SHOTS_FILE)) throw new Error("需要 --shots <shotlist.json>");
const sourceBytes = readFileSync(SHOTS_FILE);
const sourceFileHash = createHash("sha256").update(sourceBytes).digest("hex");
const sourceDocument = JSON.parse(sourceBytes.toString("utf8")) as Record<string, unknown> & { shots?: Array<Record<string, unknown>>; character?: { id?: unknown } };
const OPENING_CAPTION = verifyOpeningCaption(sourceDocument);
const PROJECT = arg("--project", basename(SHOTS_FILE, ".json"));
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(PROJECT) || PROJECT.includes("..")) throw new Error("PROJECT_ID_INVALID: 项目ID不能包含路径或特殊分隔符");
const RUN_ID = WORKER_RUNTIME?.context.runId ?? randomUUID();
const DURATION_POLICY = durationPolicy(arg("--duration-policy", String(sourceDocument.durationPolicy ?? "creative-target")));
const LIBRARY = resolve(arg("--library", join(REPO_ROOT, "var/media/characters")));
const WORK_DIR = resolve(arg("--work-dir", join(REPO_ROOT, ".vm-work")));
const GENERATION_ROOTS = filmGenerationReceiptRoots({ repoRoot: REPO_ROOT, workDir: WORK_DIR,
  artifactRoot: process.env.WORKLOOM_VIDEO_ARTIFACT_ROOT, receiptRoot: arg("--generation-receipt-root") || undefined,
  legacyVideoRoots: arg("--legacy-video-receipt-roots").split(",").map(value => value.trim()).filter(Boolean) });
const OUT_ROOT = resolve(arg("--out", join(REPO_ROOT, "outputs", PROJECT)));
const KEYS_FILE = arg("--keys-file", join(homedir(), ".workloom", "live.env"));
const BRIEF_FILE = arg("--brief");
const REVISION_CONTEXT = arg("--revision-context", "");
const ASPECT = arg("--aspect", typeof sourceDocument.aspect === "string" ? sourceDocument.aspect : "9:16");
/**
 * 云端生成保持原来的低价分辨率；UHD 只在本机取得镜头文件后执行。
 * `--resolution 2160p` 是旧参数风格的交付档别名，不传给模型提示词。
 */
const REQUESTED_RESOLUTION = arg("--resolution", typeof sourceDocument.resolution === "string" ? sourceDocument.resolution : "1080p");
const QUALITY_ARG = arg("--quality", "");
if (!["720p", "1080p", "2160p"].includes(REQUESTED_RESOLUTION)) {
  throw new Error(`--resolution 不支持 ${REQUESTED_RESOLUTION}（可选 720p / 1080p / 2160p）`);
}
if (QUALITY_ARG && !["hd", "uhd"].includes(QUALITY_ARG)) {
  throw new Error(`--quality 不支持 ${QUALITY_ARG}（可选 hd / uhd）`);
}
if (REQUESTED_RESOLUTION === "2160p" && QUALITY_ARG === "hd") {
  throw new Error("--resolution 2160p 与 --quality hd 冲突");
}
type FilmQuality = "hd" | "uhd";
const QUALITY: FilmQuality = (QUALITY_ARG || (REQUESTED_RESOLUTION === "2160p" ? "uhd" : "hd")) as FilmQuality;
const SOURCE_RESOLUTION = REQUESTED_RESOLUTION === "2160p" ? "1080p" : REQUESTED_RESOLUTION;
const OUTPUT_RESOLUTION = QUALITY === "uhd" ? "2160p" : SOURCE_RESOLUTION;
/** UHD 全套交付文件先留在与正式目录同卷的源版本暂存区，交付门全过后整体发布。 */
const PUBLIC_OUT_DIR = QUALITY === "uhd" ? join(OUT_ROOT, "uhd") : OUT_ROOT;
const PUBLIC_RELEASE_DIR = QUALITY === "uhd" ? join(PUBLIC_OUT_DIR, "releases", RUN_ID) : PUBLIC_OUT_DIR;
const OUT_DIR = QUALITY === "uhd" ? join(OUT_ROOT, ".uhd-staging", RUN_ID) : OUT_ROOT;
function publicDeliveryPath(path: string): string {
  if (QUALITY !== "uhd") return path;
  const rel = relative(OUT_DIR, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`UHD_DELIVERY_PATH_OUTSIDE_STAGING: ${path}`);
  }
  return join(PUBLIC_RELEASE_DIR, rel);
}
/** 以短边为 720/1080/2160，四种交付画幅用同一个推导口径。 */
function dimensionsFor(aspect: string, resolution: string): { width: number; height: number } {
  const shortEdge = Number(resolution.replace(/p$/, ""));
  const ratio: Record<string, [number, number]> = {
    "9:16": [9, 16], "16:9": [16, 9], "1:1": [1, 1], "4:5": [4, 5]
  };
  const pair = ratio[aspect];
  if (!pair || ![720, 1080, 2160].includes(shortEdge)) {
    throw new Error(`不支持画幅/分辨率组合：${aspect} ${resolution}`);
  }
  const [x, y] = pair;
  const width = Math.round(shortEdge * x / Math.min(x, y));
  const height = Math.round(shortEdge * y / Math.min(x, y));
  if (width % 2 !== 0 || height % 2 !== 0) throw new Error(`编码尺寸必须为偶数：${width}x${height}`);
  return { width, height };
}
const SOURCE_SIZE = dimensionsFor(ASPECT, SOURCE_RESOLUTION);
const OUTPUT_SIZE = dimensionsFor(ASPECT, OUTPUT_RESOLUTION);
function sampleDimensions(shortEdge: number): { width: number; height: number } {
  const sourceShort = Math.min(SOURCE_SIZE.width, SOURCE_SIZE.height);
  return {
    width: Math.round(SOURCE_SIZE.width * shortEdge / sourceShort),
    height: Math.round(SOURCE_SIZE.height * shortEdge / sourceShort)
  };
}
const ENHANCE_KIND = arg("--enhance-kind", "live-action");
if (!["live-action", "animation"].includes(ENHANCE_KIND)) {
  throw new Error(`--enhance-kind 不支持 ${ENHANCE_KIND}（可选 live-action / animation；文字画面须原生渲染）`);
}
const ENHANCE_ENGINE_DIR = arg("--enhance-engine-dir", "");
const FPS = Number(arg("--fps", "30"));
const MAX_ATTEMPTS = Math.max(1, Number(arg("--max-attempts", "1")) || 1);   // 默认不做盲重试（T-2026-0929-0009）
/** 转场淡入淡出时长（秒）：快剪片（小红书/瞭望塔风格）用 0.1–0.2，抒情片用 0.5 */
const XFADE = Number(arg("--xfade", "0.5"));
/**
 * 逐刀转场（2026-09-25 新增，产品所有者第二轮反馈"运镜拉跨、不像《土耳其瞭望塔》"）：
 * 默认硬切；不允许用重叠转场吃掉已渲染镜头时长。
 * 注意与 `--xfade` 的分工：`--xfade` 只管首尾淡入淡出（compose 的 fade），逐刀转场是这一对参数。
 */
const CUT_TRANSITION = arg("--cut-transition", "");
const CUT_TRANSITION_DURATION = Number(arg("--cut-transition-duration", "0.18"));
/**
 * 转场只作用在这些**入点**（第 N 个镜头进场处，1 起）；空 = 每一刀都做。
 * 滕王阁片：只在进入/离开中段快剪的 4 处做甩镜转场（人物口播镜之间保持硬切），
 * 这样既拿到瞭望塔式的甩镜节奏，又不把总时长吃掉（6 镜满刀 0.18s 会掉到 29.2s，真机被打回）。
 */
const CUT_TRANSITION_AT = arg("--cut-transition-at", "2,3,4,5");
/**
 * 镜头顺序口径（2026-09-26 产品所有者点名）：
 *   `storyboard`（默认）= 成片顺序必须等于分镜顺序，后期不得为卡点/情绪重排；
 *   `reuse-assembly`    = 媒资库历史镜头复用路径，允许重组，但必须给 `--reuse-plan` 重组依据。
 * 重排入口用 `--compose-order NC-04,NC-01,...` 显式声明；不声明就按分镜顺序。
 */
const ORDER_POLICY = arg("--order-policy", "storyboard") as "storyboard" | "reuse-assembly";
const COMPOSE_ORDER = arg("--compose-order", "");
const REUSE_PLAN = arg("--reuse-plan", "");
/**
 * 封面主版式（2026-09-25 南昌片收口）：
 *   `landmark`（默认）= 地标满幅 + 人物卡（适合"人物镜头质量一般"的片子）；
 *   `split`          = **左侧地标满幅 + 右侧人物竖带**（无卡片硬边，双主体都清晰；当"人物卡贴在地标上"反复被判 "贴图感/遮挡主体"时的收口版式）；
 *   `person`         = **人物满幅 + 地标小图**——当"人物卡贴在地标上"反复被判
 *                      "贴图感/遮挡主体/人物不是主角"时改用这一版：人物是背景（不存在贴片边缘），
 *                      地标以柔边小图出现在右上角，三件套（人物/地标/标题）仍然齐备。
 *   `person-solo`    = **人物满幅 + 不叠任何小图**（口播/讲解类片子的收口版式，2026-09-27 真机）：
 *                      文字块下移到**面部下方安全带**（画面 58%–88%），从根上避免"标题压在主角脸上"；
 *                      适用范围=人物本身就是唯一主视觉的片子（带货口播、讲解、访谈）。
 */
const COVER_HERO = arg("--cover-hero", "landmark");
/**
 * 封面版式（2026-09-26 产品所有者口径，收敛为两种主视觉）：
 *   · `subject-led`（物体为主）：景物/商品/动物等**非人主体**满幅 + 标题（`--cover-hero subject|scenery`）；
 *   · `person-led`（人物为主）：人物是唯一主视觉，背景只作点缀（`--cover-hero person`）。
 * 旧的 `landmark`（地标 + 人物卡）与 `split`（左地标右人物竖带）保留为兼容档，但不再是推荐默认。
 */
const COVER_ARCHETYPE: "person-led" | "subject-led" =
  ["subject", "scenery", "object", "product"].includes(COVER_HERO) ? "subject-led" : "person-led";
/** 人物满幅 + 无小图 + 文字下移安全带（person-solo 专属口径） */
const COVER_LOWER_BAND_TEXT = COVER_HERO === "person-solo";
/**
 * 封面平台（2026-09-27 平台化）：
 *   `--cover-platform` 显式指定封面平台（`douyin|kuaishou|xiaohongshu|wechat-channels|bilibili|tiktok|youtube|instagram-reels`，
 *   也接受"抖音/小红书"这类中文别名）；缺省沿用 `--platform`（历史默认值"抖音/快手"→抖音口径）。
 *   平台规格（画幅/画布/安全区/标题带/字数上限）来自 `packages/video-studio/src/cover-platforms.ts`——
 *   封面侧唯一事实源；**抖音默认路径与平台化之前逐像素一致**（有单测锁死）。
 */
const COVER_PLATFORM_ARG = arg("--cover-platform", "");
if (COVER_PLATFORM_ARG && !isKnownCoverPlatform(COVER_PLATFORM_ARG)) {
  throw new Error(`--cover-platform 未知平台：${COVER_PLATFORM_ARG}（可选：${COVER_PLATFORM_IDS.join(" / ")}，或中文别名 抖音/快手/小红书/视频号/B站）`);
}
/** 封面知识库（cover-kb）注入开关：默认开启（`--no-cover-kb` 关闭，退化为平台化之前的行为） */
const COVER_KB_ENABLED = !flag("--no-cover-kb");
const COVER_KB_DIR = resolve(arg("--cover-kb-dir", join(REPO_ROOT, "bundles/ai-video/library/cover-kb")));
/**
 * 封面题材（`--theme`）：进 cover-kb 的题材映射（theme → 版式/字级/配色）。
 * 缺省从片名 + brief.goal 启发式匹配 THEME-001 题材表；匹配不到就**不注入题材条目**（不硬凑）。
 */
const COVER_THEME_ARG = arg("--theme", "");
/** 账号定位档案（`--account <id>`）：读 `bundles/ai-video/library/account-profiles/<id>.yml`，注入视觉锤约束 */
const COVER_ACCOUNT_ARG = arg("--account", "");
const COVER_ACCOUNT_DIR = resolve(arg("--account-dir", join(REPO_ROOT, "bundles/ai-video/library/account-profiles")));
const DANMAKU_FILE = arg("--danmaku");
/** 只跑指定镜头（逗号分隔；用于单镜验证与局部重跑） */
const ONLY = arg("--only").split(",").map((s) => s.trim()).filter(Boolean);
/**
 * 监制已知悉但放行的镜头（逗号分隔）。
 * 用途：监制打回、但客观条件（账号欠费/额度用尽/时效）不允许重跑时，
 * **不允许静默放行**——必须显式列出，运行日志与阶段记录里要留"带瑕疵放行"的痕迹。
 */
const ACCEPT_REJECTED = arg("--accept-rejected").split(",").map((s) => s.trim()).filter(Boolean);
/** 只做后期运镜增强、不提交新渲染（额度受限/只想换运镜设计时用） */
const MATERIAL_POST_ONLY = flag("--material-post-only");
/**
 * 纯后期组装模式（T-2026-0929-0012，真机事故沉淀）：
 * 当源镜头是**外部拿到的成品片段**（未过本片 shot/voice 回执）时，允许继续走完整后期链
 * （合成→调色→字幕→配乐→封面设计师→母版→变体交付包），但必须：
 *   1 显式传 `--assembly-mode post-only --assembly-reason "<原因>"`；
 *   2 落一条 degraded 门记录（哪些镜头无回执）；
 *   3 交付清单里标 assemblyMode=post-only、shotReceiptsMissing=[…]。
 * 目的：把"绕开管线、手工做封面/BGM"这条歪路堵死——要么走完整链并留痕，要么不做。
 */
const POST_ONLY_ASSEMBLY = arg("--assembly-mode", "") === "post-only";
const POST_ONLY_REASON = arg("--assembly-reason", "").trim();
if (POST_ONLY_ASSEMBLY && POST_ONLY_REASON.length < 8) {
  throw new Error("post-only 组装必须显式给出 --assembly-reason \"<至少 8 字原因>\"（说明源镜头为何没有本片回执）");
}
const EDIT_EXCLUDE = arg("--post-exclude-shots");
const PRESENTATION_FILE = arg("--presentation-plan");
const PRESENTATION = PRESENTATION_FILE ? readFilmPresentation(abs(PRESENTATION_FILE), DELIVERY_VARIANTS.map(row => row.id)) : null;
const END_CARD_IMAGE = arg("--end-card-image") ? abs(arg("--end-card-image")) : PRESENTATION?.main.endCard.path ?? "";
const END_CARD_SECONDS = endCardSeconds(END_CARD_IMAGE, arg("--end-card-seconds"));
assertPreservedSourceTiming({ retimeTo: Number(arg("--retime-to", "0")), transition: CUT_TRANSITION, transitionDuration: CUT_TRANSITION_DURATION });
/** post-only 组装时"无本片回执"的镜头清单（交付清单里如实列出，供客户/审计复核） */
let postOnlyMissingReceipts: string[] = [];
/**
 * 配乐层状态：实际原节目音混音、明确无配乐请求或明确签章来源。
 * bgm 阶段在自己的块作用域里算出结论，这里提升到模块作用域供交付清单与母版终审引用。
 */
let bgmManifestInfo: Record<string, unknown> | null = null;
/**
 * 保留旧声明参数兼容性；没有显式签章分轨引用时，默认按源片原节目音加工。
 * 母版与变体共用相同来源合同，回执记录 original-program-bytes 与 stemsVerified=false。
 */
const BGM_DECLARED_PROGRAM_MIX = flag("--bgm-declared-program-mix")
  || !String(process.env.WORKLOOM_AUDIO_STEM_SIGNING_SECRET ?? "").trim();
/** 后期速度坡道只由显式参数或镜头意图启用，默认保持原速度 */
const BGM_TARGET_LUFS = parseBgmTargetLufs(arg("--bgm-lufs", "-14"));
const MATERIAL_SPEED_RAMP = flag("--material-speed-ramp") && !flag("--no-material-speed-ramp");
/**
 * 后期数字运镜（变焦 + 换景别切，默认**关**）。
 * 产品所有者口径：画面里的运镜必须由模型构建（参考图只作实景依据），数字变焦只作应急手段。
 */
const MATERIAL_POST_CAMERA_MOVE = flag("--material-post-camera-move");
if (MATERIAL_SPEED_RAMP || MATERIAL_POST_CAMERA_MOVE) throw new Error("SOURCE_TIMING_PROTECTED: preserve the original rendered performance; use separately authored postproduction segments");
/**
 * 从镜头卡解析**角色 id**（角色一致性判据用）：
 * 优先显式 `characterId`；否则用 `character` 字段的名字（主角按 cast.lead 归并，临时角色按名字）。
 * 为什么不猜：名字不同但其实是同一人的情况由上游 `characterId` 显式声明解决，
 * 本函数只在缺声明时给出**稳定且可追溯**的 id（写进证据，便于人工复核）。
 */
function characterIdOf(shot: Record<string, unknown>): string | null {
  const explicit = String((shot as { characterId?: unknown }).characterId ?? "").trim();
  if (explicit) return explicit;
  const name = String((shot as { character?: unknown }).character ?? "").trim();
  if (!name) return null;
  return name.slice(0, 32);
}

const RESUME = !flag("--no-resume");
const DRY_RUN = flag("--dry-run");
const ALLOW_FALLBACK_APPROVE = flag("--allow-fallback-approve");
const STAGES = new Set(
  /**
   * 默认阶段的并集：
   *   `cine-kb`（摄影知识库）/ `continuity`（连贯性导演评审）/ `micromotion`（微动作增强，T-2026-0924-0001 第二次收口）
   *   `mux`（软字幕轨收口，T-2026-0924-0070/0071）
   */
  /**
   * 与上一版的差别（2026-09-25）：
   *   · `photo-motion` 已**移除**——真实素材不再有"静态直出"路径，改为 `material-gen`（素材当生成输入）；
   *   · `voice` 默认保留源音轨；只有明确统一配音请求才执行配音变换。
   */
  /**
   * 2026-09-26 产品口径补充：`deliver`（多风格交付包）**默认开启**——
   * 真机复盘发现"一次产出几个版本"的约束一直没执行，根因就是它不在默认阶段表里，
   * 只有显式 `--stages ...,deliver` 才会跑，于是日常跑全链根本不产变体。
   */
  arg("--stages", "cine-kb,continuity,micromotion,spec,plates,material-gen,videos,voice,compose,color,subtitle,danmaku,bgm,cover,mux,master,deliver").split(",").map((s) => s.trim()).filter(Boolean)
);
/**
 * 字幕落地方式（2026-09-24 产品所有者口径）：
 *   sidecar（缺省）= 母版**不烧字**，出旁挂字幕文件（srt/ass/vtt + 清单）并另出一支软字幕轨版；
 *   burn           = 旧行为：把字幕烧进画面（母版变成带字版）；
 *   both           = 旁挂 + 烧字副本都出（发布方想两条路都留）。
 * 为什么默认改成 sidecar：**有些片子要带字幕、有些不要**，而"要不要"是后期/发布时的选择；
 * 烧一次就回不去了（画面像素被改），旁挂文件则可以随时软轨内嵌或再烧。
 */
const SUBTITLE_MODE = (() => {
  const value = arg("--subtitle-mode", "sidecar");
  if (!["sidecar", "burn", "both"].includes(value)) {
    throw new Error(`--subtitle-mode 只支持 sidecar | burn | both，收到：${value}`);
  }
  return value as "sidecar" | "burn" | "both";
})();

const VALID_STAGES = new Set(["cine-kb", "continuity", "micromotion", "spec", "plates", "material-gen", "surface-repair", "identity-check", "videos", "voice", "compose", "color", "subtitle", "danmaku", "bgm", "sfx", "cover", "mux", "master", "deliver", "revise"]);
for (const stage of STAGES) if (!VALID_STAGES.has(stage)) throw new Error(`UNKNOWN_STAGE: ${stage}`);
if (POST_ONLY_ASSEMBLY && ["plates", "material-gen", "videos"].some(stage => STAGES.has(stage))) {
  throw new Error("POST_ONLY_GENERATION_FORBIDDEN: editorial changes must not submit any generation work");
}
if (STAGES.has("surface-repair") && (STAGES.size !== 1 || ONLY.length !== 1 || DRY_RUN)) {
  throw new Error("SURFACE_REPAIR_SCOPE: 必须仅选择一个已有成功渲染的镜头；本地修复不得同次触发生成或交付阶段");
}
if (STAGES.has("identity-check") && (STAGES.size !== 1 || ONLY.length !== 1 || DRY_RUN)) {
  throw new Error("IDENTITY_CHECK_SCOPE: 兼容入口仅登记一个已有成功渲染的镜头，不进行质量复评；不触发新渲染或整片交付");
}
if (STAGES.has("deliver")) STAGES.add("master");
/** 已成功渲染进入后期时不自动添加 spec；范围、真实任务、当前输入/产物字节仍核对。 */
assertSelectedShotStageScope(STAGES, ONLY);
if (!DRY_RUN && (ACCEPT_REJECTED.length || ALLOW_FALLBACK_APPROVE || flag("--accept-env-defects") || flag("--accept-av-sync-drift"))) {
  throw new Error("PRODUCTION_BYPASS_REJECTED: 生产不能通过豁免参数把未通过或未核实变为合格；请调用对应组件修复后重新验证。");
}
const LOG_DIR = join(WORK_DIR, "logs", PROJECT);
const STAGE_LOG = join(LOG_DIR, "stages.jsonl");
const PLATE_DIR = join(WORK_DIR, "plates", PROJECT);
const CLIP_DIR = join(WORK_DIR, "clips", PROJECT);

const productionClipPaths = new Map<string, string>();
/** 局部处理不覆盖模型原片；下游只通过该入口读取已核实的生产副本。 */
function productionClipFile(shotId: string): string { return productionClipPaths.get(shotId) ?? join(CLIP_DIR, `${shotId}.mp4`); }
const POST_DIR = QUALITY === "uhd" ? join(WORK_DIR, "post", PROJECT, "uhd") : join(WORK_DIR, "post", PROJECT);
const PROMPT_DIR = join(WORK_DIR, "prompts", PROJECT);
/** 成片交付路径（模板块与交付包/返修块共用；模板块内部变量名保持 `deliverable` 不变） */
const DELIVERABLE = join(OUT_DIR, `${PROJECT}-30s-final.mp4`);
/**
 * 成片的**实际交付路径**（2026-09-26 口径统一）：
 * 旧名写死 `-30s-final.mp4`，但片子可能是 48s/51s——发布方按文件名核对会踩空（真机事故）。
 * 下面在落盘时按**实测时长**重命名（如 `-48s-final.mp4`），并把这个路径用于交付清单与变体派生。
 */
let deliverablePath = DELIVERABLE;
let masterApprovedForUhd = false;
/** 工位路径白名单（冒号分隔）：仓库根 + 运行产物根 + 交付目录 + 系统临时目录 */
const CLI_ALLOWED_ROOTS = [REPO_ROOT, WORK_DIR, OUT_DIR, tmpdir()].join(":");
/**
 * 配乐工位额外白名单（2026-09-30 真机）：本地**无版权曲库**是产品所有者自己放在
 * `~/.workloom-bgm/library`（索引指向原始下载目录）里的——变体配乐的"按曲风挑曲"会命中
 * `~/Downloads/...` 的真实文件路径。工位路径监狱只放行 CLI_ALLOWED_ROOTS 时，
 * 混音会被 `path_not_allowed` 拦下（真机：变体三支全部缺配乐 → G-DLV1 三轴判据误红）。
 * 这里只给**配乐工位**加这两个曲库根；其它工位白名单不变。
 */
const BGM_LIBRARY_ROOTS = [join(homedir(), ".workloom-bgm"), join(homedir(), "Downloads"), join(homedir(), "Music")]
  .filter((dir) => existsSync(dir));
const BGM_ALLOWED_ROOTS = [CLI_ALLOWED_ROOTS, ...BGM_LIBRARY_ROOTS].join(":");
for (const dir of [LOG_DIR, PLATE_DIR, CLIP_DIR, POST_DIR, PROMPT_DIR, OUT_DIR]) mkdirSync(dir, { recursive: true });

/** 环境：进程环境优先，其次仓库外秘密文件（只进内存，不落盘） */
function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  if (WORKER_RUNTIME) {
    for (const [key, value] of Object.entries(process.env)) if (value) out[key] = value;
    return out;
  }
  if (existsSync(KEYS_FILE)) {
    for (const line of readFileSync(KEYS_FILE, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && m[2]!.trim()) out[m[1]!] = m[2]!.trim();
    }
  }
  if (existsSync(join(REPO_ROOT, ".env"))) {
    for (const line of readFileSync(join(REPO_ROOT, ".env"), "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && m[2]!.trim() && !out[m[1]!]) out[m[1]!] = m[2]!.trim();
    }
  }
  for (const [key, value] of Object.entries(process.env)) if (value && !out[key]) out[key] = value;
  return out;
}
const ENV = loadEnv();
const ARK_KEY = ENV.VOLCENGINE_ARK_API_KEY ?? ENV.ARK_API_KEY ?? "";
const ARK_BASE = (ENV.ARK_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3").replace(/\/$/, "");
const IMAGE_MODEL = ENV.SEEDREAM_MODEL ?? ENV.ARK_IMAGE_MODEL ?? "doubao-seedream-5-0-pro-260628";
const VIDEO_MODEL = ENV.SEEDANCE_MODEL ?? ENV.ARK_VIDEO_MODEL ?? "doubao-seedance-2-5-260628";
/* ================= 阶段日志 ================= */

type StageRecord = {
  at: string;
  stage: string;
  shotId: string | null;
  invoked: boolean;
  ok: boolean;
  cached: boolean;
  degraded: boolean;
  attempt: number;
  ms: number;
  artifact: string | null;
  evidence: Record<string, unknown>;
  verdict: ProducerVerdict | null;
  note?: string;
  /** 门事件专用：管线 step_key 与门编号（G5/G6/G7/G8） */
  stepKey?: PipelineGateStepKey;
  gate?: string;
  lineage?: LineageReceipt;
  approved?: boolean;
  checks?: GateCheck[];
  shotIds?: string[];
  sourceStage?: string | null;
  via?: GateEvent["via"];
  score?: number | null;
  reason?: string;
};
const records: StageRecord[] = [];
if (!Array.isArray(sourceDocument.shots) || !sourceDocument.shots.length) throw new Error("SHOT_REGISTRY_REQUIRED");
const sourceIds = sourceDocument.shots.map((shot) => String(shot.shotId ?? ""));
if (sourceIds.some((id) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || id.includes("..")) || new Set(sourceIds).size !== sourceIds.length) throw new Error("SHOT_REGISTRY_INVALID: 镜号缺失、重复或包含路径字符");
if (ONLY.some((id) => !sourceIds.includes(id))) throw new Error("SHOT_SCOPE_UNKNOWN: --only 包含未登记镜号");
/**
 * 视频类型分流前置（T-2026-0930-0015，2026-09-30 真机复盘沉淀）。
 *
 * 分流器 `pipeline-router.ts` 此前只接在**服务端派活**上；AI agent / 交付同学直接跑本 CLI 时会
 * 跳过"先判营销片 / 叙事片 / 口播解说片"。这里把它变成**出片入口的 fail-closed 前置**：
 *   · `--route work/route.json`（由 scripts/tools/route-video.mts 生成）；或
 *   · `--route-kind marketing|narrative`（已确认过的补跑项目，显式声明并留痕）。
 * 营销片必须有商品锚点（纪律：**不猜商品**）；分流结论是"判不准"时必须先问用户，不许替用户花钱。
 */

const lineageComponentHash = productionHash({
  film: sha256FileSync(join(REPO_ROOT, "scripts/tools/full-chain-film.mts")),
  surfaceRepair: sha256FileSync(join(REPO_ROOT, "packages/video-studio/src/video-surface-repair.ts")),
  videoReceipt: sha256FileSync(join(REPO_ROOT, "packages/video-studio/src/video-task-receipt.ts")),
});
const SCENE_BIBLE_FILE = arg("--scene-bible");
const sceneBible: SceneBible | null = SCENE_BIBLE_FILE
  ? JSON.parse(readFileSync(abs(SCENE_BIBLE_FILE), "utf8")) as SceneBible
  : (sourceDocument.sceneBible as SceneBible | undefined) ?? null;
const AUTHOR_CONTEXT_FILE = join(LOG_DIR, "project-context.json");
const authorContext = loadOrCreateFilmAuthorContext({ path: AUTHOR_CONTEXT_FILE, projectId: PROJECT,
  eraProfile: sourceDocument.eraProfile ?? sceneBible?.eraProfile });
const filmContractSource = { projectId: PROJECT, shots: sourceDocument.shots!, eraProfile: authorContext.eraProfile,
  ...(sceneBible ? { sceneBible } : {}) };
/**
 * 审核层策略（T-2026-0930-0014，产品所有者口径）：
 *   · 渲染**前**把关靠管线已有的**标准规范**（红线 linter、合同字段、参数与授权事实、素材用途/溯源）；
 *     目标是"提交前把问题清零，一次渲染成功"，而不是"渲完再挑毛病"。
 *   · 渲染**后**不再做"合格/不合格"裁决：片子渲出来了就**直接走完整后期链并交付**，
 *     由客户验收判断好坏（真机教训：监制判"不合格"的素材，客户往往认为可用；
 *     事后裁决既拖长交付时间，又反复重渲烧钱）。
 *   · 因此默认 `--review-policy off`：不调用评审模型；**只保留事实性硬闸**
 *     （产物存在/时长/分辨率/文件与命名这类最终交付事实）。
 *   · `--review-policy advisory|blocking` 仅控制生成前评审；不恢复成功源片二次质量门。
 */
type ReviewPolicy = "off" | "advisory" | "blocking";
const REVIEW_POLICY = (arg("--review-policy", "off").trim() || "off") as ReviewPolicy;
if (!["off", "advisory", "blocking"].includes(REVIEW_POLICY)) {
  throw new Error(`--review-policy 只支持 off / advisory / blocking，收到：${REVIEW_POLICY}`);
}
const REVIEW_DISABLED_REASON = "供应商成功片段直接后期；只核对实际加工和最终交付文件，未复评源片身份/画面/运动/声音；新提交仍核对原请求、参数和授权";
/** 事实性硬闸：与"好看不好看"无关，失败即产物或交付规格不成立 */
function deterministicHardFailures(options: Omit<ProducerGateOptions, "contracts">): string[] {
  return options.deterministic
    .filter((check) => check.hard === true && (check.status === "failed" || (check.status === undefined && check.pass === false)))
    .map((check) => `${check.id}：${check.detail}`);
}
function syntheticReviewVerdict(
  options: Omit<ProducerGateOptions, "contracts">, hardFailures: string[], issues: string[], reason: string,
): ProducerVerdict {
  return {
    stage: options.stage,
    status: hardFailures.length > 0 ? "failed" : "passed",
    approved: hardFailures.length === 0,
    score: hardFailures.length > 0 ? 0 : 100,
    hardFailures,
    issues,
    suggestions: hardFailures.length > 0 ? [`修复事实性硬闸后重跑：${hardFailures[0]}`] : [],
    rerun: hardFailures.length > 0,
    via: "deterministic",
    ms: 0,
    reason,
    degraded: false,
    evidence: [],
  };
}
async function reviewStage(options: Omit<ProducerGateOptions, "contracts">): Promise<ProducerVerdict> {
  // Postproduction never resurrects source quality review, including legacy blocking/advisory options.
  if (POST_RENDER_STAGES.has(options.stage)) {
    return acceptPostStage(options);
  }
  if (WORKER_RUNTIME) return WORKER_RUNTIME.review(options);
  /** 事实性硬闸任何策略下都不放过（"渲出来没有/规格不对"不是审美问题） */
  const hardFailures = deterministicHardFailures(options);
  if (hardFailures.length > 0) {
    return syntheticReviewVerdict(options, hardFailures, options.deterministic.filter((c) => c.pass === false).map((c) => `${c.id}：${c.detail}`),
      `事实性硬闸未通过（${hardFailures.length} 项）`);
  }
  if (REVIEW_POLICY === "off") {
    return syntheticReviewVerdict(options, [], options.deterministic.filter((c) => c.pass === false).map((c) => `${c.id}：${c.detail}`),
      REVIEW_DISABLED_REASON);
  }
  const verdict = await reviewFilmStage(filmContractSource, options);
  if (REVIEW_POLICY === "advisory") {
    /** 咨询模式：意见照记，但**不阻断交付**（approved 归一为 true，评审内容留在 issues/reason 里） */
    return { ...verdict, approved: true, status: "passed", rerun: false, degraded: false,
      reason: `[advisory] ${verdict.reason}` };
  }
  return verdict;
}
const sourceSupportFiles = [AUTHOR_CONTEXT_FILE, ...(BRIEF_FILE ? [abs(BRIEF_FILE)] : []), ...(arg("--scene-bible") ? [abs(arg("--scene-bible"))] : [])];
const sourceSnapshot = captureLineageInputs(sourceSupportFiles);
if (sourceSnapshot.errors.length) throw new Error(`SOURCE_UNREADABLE: ${sourceSnapshot.errors.join("; ")}`);
const sourceSupportHashes = new Map(sourceSnapshot.artifacts.map((entry) => [entry.path, entry.sha256]));
const lineageInputPaths = new Map<string, string[]>();
const lineageInputSnapshots = new Map<string, LineageInputSnapshot>();
const UHD_DELIVERY_STAGES = new Set([
  "enhance", "compose", "character-consistency", "color", "subtitle", "danmaku", "bgm", "sfx",
  "cover", "cover-intro", "mux", "master", "deliver",
]);
function uhdDeliveryStage(stage: string): boolean {
  return QUALITY === "uhd" && (UHD_DELIVERY_STAGES.has(stage) || stage.startsWith("gate:deliver:"));
}
function sourceHashFor(shotId: string | null, stage: string): string {
  const { shots: allShots, durationSeconds: _total, ...common } = sourceDocument;
  return productionHash({
    source: shotId ? { ...common, shot: allShots!.find((shot) => shot.shotId === shotId) ?? null } : { ...sourceDocument, selectedShotIds: ONLY, editorialExclusions: EDIT_EXCLUDE },
    brief: BRIEF_FILE ? sourceSupportHashes.get(abs(BRIEF_FILE)) ?? null : null,
    sceneBible: arg("--scene-bible") ? sourceSupportHashes.get(abs(arg("--scene-bible"))) ?? null : null,
    eraProfile: authorContext.eraProfile, aspect: ASPECT, resolution: SOURCE_RESOLUTION, fps: FPS,
    ...(uhdDeliveryStage(stage) ? { quality: QUALITY, shotlistSha256: sourceFileHash } : {}),
  });
}
function lineageStage(rec: Pick<StageRecord, "stage" | "stepKey" | "evidence">): string {
  return rec.stage === "gate" ? `gate:${rec.stepKey}:${String(rec.evidence.mode ?? "")}` : rec.stage;
}
function lineageRecipe(stage: string): Record<string, unknown> {
  const prefixes = stage === "color" ? ["--color-"] : stage === "bgm" ? ["--bgm-"]
    : stage === "voice" ? ["--narration-", "--speech-"] : stage === "cover" ? ["--cover-", "--theme", "--account", "--no-cover-"]
    : stage === "compose" ? ["--xfade", "--cut-transition", "--order-policy", "--compose-order", "--compose-tail-holds", "--reuse-plan", "--end-card-", "--presentation-plan", "--post-exclude-shots"]
    : stage === "subtitle" || stage === "mux" ? ["--subtitle-", "--opening-title", "--no-title-card"]
    : stage === "danmaku" ? ["--danmaku", "--no-danmaku"] : [];
  const args = process.argv.slice(2), options: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) if (prefixes.some((prefix) => args[i]!.startsWith(prefix))) options[args[i]!] = args[i + 1] && !args[i + 1]!.startsWith("--") ? args[i + 1]! : true;
  return { component: lineageComponentHash, stage, platform: arg("--platform", "抖音/快手"), subtitleMode: SUBTITLE_MODE, options,
    ...(uhdDeliveryStage(stage) ? { quality: QUALITY, shotlistSha256: sourceFileHash } : {}) };
}
function lineageRecords(rows: StageRecord[], stage: string): StageRecord[] {
  const recipeHash = productionHash(lineageRecipe(stage));
  // HD source clips can feed UHD enhancement. For delivery stages, only the
  // latest verdict from the requested quality/recipe may decide publication.
  return rows.map((row) => ({ ...row, stage: lineageStage(row) }))
    .filter((row) => row.stage === stage && (!row.lineage || row.lineage.recipeHash === recipeHash));
}
function stageApproved(stage: string, shotIds: Array<string | null> = [null], rows = readStageHistory()): boolean {
  return stageLineageApproved({ records: lineageRecords(rows, stage), projectId: PROJECT, stage, shotIds,
    sourceHash: (id) => sourceHashFor(id, stage), recipe: lineageRecipe(stage) }).ok;
}
function rememberInputs(stage: string, paths: string[], shotId: string | null = null): void {
  const key = `${stage}:${shotId ?? ""}`;
  const all = [...new Set([...sourceSupportFiles, ...paths])];
  lineageInputPaths.set(key, all);
  lineageInputSnapshots.set(key, captureLineageInputs(all));
}
function artifactReusable(stage: string, candidate: string, upstream?: string, shotId: string | null = null): boolean {
  return reusableLineageArtifact({ records: lineageRecords(readStageHistory(), stage),
    scope: { projectId: PROJECT, sourceHash: sourceHashFor(shotId, stage) },
    stage, shotId, recipe: lineageRecipe(stage), candidate, upstream });
}
function record(rec: Omit<StageRecord, "at">): StageRecord {
  if (sha256FileSync(SHOTS_FILE) !== sourceFileHash) throw new Error("SOURCE_CHANGED_DURING_RUN: 分镜源文件运行中发生变化，请从当前版本重新开始");
  const stage = lineageStage(rec);
  const declaredOutputs = [rec.artifact, ...(Array.isArray(rec.evidence.outputFiles) ? rec.evidence.outputFiles : [])].filter((file): file is string => typeof file === "string" && Boolean(file));
  const notApplicable = !rec.invoked && rec.ok && (rec.evidence.applicable === false || rec.evidence.dialogue === false || Boolean(rec.evidence.skipReason));
  const status = rec.degraded || rec.verdict?.degraded ? "unverified" : !rec.ok || rec.verdict?.approved === false ? "failed" : notApplicable ? "not_applicable" : "passed";
  const lineage = createLineageReceipt({ projectId: PROJECT, sourceHash: sourceHashFor(rec.shotId, stage), runId: RUN_ID, stage, shotId: rec.shotId,
    recipe: lineageRecipe(stage), status, inputs: lineageInputPaths.get(`${stage}:${rec.shotId ?? ""}`) ?? sourceSupportFiles,
    inputSnapshot: lineageInputSnapshots.get(`${stage}:${rec.shotId ?? ""}`) ?? sourceSnapshot, outputs: declaredOutputs, reviewedArtifacts: rec.verdict?.evidence,
    ...(notApplicable ? { notApplicableReason: rec.note ?? "镜头契约明确不适用" } : {}),
  });
  const ok = lineage.status === "passed" || lineage.status === "not_applicable";
  const full: StageRecord = { at: stamp(), ...rec, evidence: { ...rec.evidence, ...(REVISION_CONTEXT ? { revisionContext: REVISION_CONTEXT } : {}) }, ok, degraded: lineage.status === "unverified", lineage,
    ...(rec.stage === "gate" ? { approved: ok } : {}) };
  records.push(full);
  appendFileSync(STAGE_LOG, `${JSON.stringify(full)}\n`, "utf8");
  const tag = full.ok ? (full.degraded ? "DEGRADED" : "ok") : "FAIL";
  log(`  ⇢ [${full.stage}${full.shotId ? ` ${full.shotId}` : ""}] ${tag}${full.cached ? "（复用）" : ""} ${full.ms}ms${full.artifact ? ` → ${full.artifact}` : ""}`);
  return full;
}

/**
 * 门事件记账（2026-09-24，G5/G6/G7/G8 的 step_key 级运行时组件）。
 *
 * 为什么需要：管线 yml 声明了四个按 step_key 记账的确认门，但运行时不落事件——
 * 审计只能看到"环节调没调用"，看不到"门有没有被按名调用、判据是什么、谁放行的"。
 * 现在每次门判定都往**同一个 stages.jsonl** 追加一条 `stage: "gate"` 记录
 * （规范形状见 `packages/video-studio/src/gate-ledger.ts`），平台执行器与审计器都能按 step_key 检索。
 */
function recordGate(input: {
  stepKey: PipelineGateStepKey;
  sourceStage: string | null;
  checks: GateCheck[];
  shotIds?: string[];
  softApproved?: boolean | null;
  via?: GateEvent["via"];
  score?: number | null;
  reason?: string;
  degraded?: boolean;
  evidence?: Record<string, unknown>;
}): GateEvent {
  const event = buildGateEvent({ projectId: PROJECT, ...input });
  const scopeShotId = input.shotIds?.length === 1 ? input.shotIds[0]! : null;
  const gateStage = `gate:${event.stepKey}:${String(input.evidence?.mode ?? "")}`;
  const gatePaths = (input.shotIds ?? []).flatMap((id) => [join(PROMPT_DIR, `${id}.txt`), join(PLATE_DIR, `${id}-plate.png`), productionClipFile(id)].filter((file) => existsSync(file)));
  const material = input.evidence?.material as Record<string, unknown> | undefined;
  for (const value of [input.evidence?.photo, input.evidence?.promptFile, material?.photo, material?.prepared, material?.promptFile]) {
    if (typeof value === "string" && value) gatePaths.push(abs(value));
  }
  rememberInputs(gateStage, gatePaths, scopeShotId);
  const bound = record({
    ...event,
    stage: "gate", shotId: input.shotIds?.length === 1 ? input.shotIds[0]! : null,
    invoked: true, ok: event.ok, cached: false, degraded: event.degraded, attempt: 1, ms: 0, artifact: null,
    evidence: { stepKey: event.stepKey, gate: event.gate, via: event.via, score: event.score, sourceStage: event.sourceStage, shotIds: event.shotIds, checks: event.checks, reason: event.reason, ...(event.evidence ?? {}) },
    verdict: null, note: `门 ${event.gate}（${event.stepKey}）`, stepKey: event.stepKey, gate: event.gate
  });
  const tag = event.ok ? (event.degraded ? "DEGRADED" : "ok") : "FAIL";
  log(`  ⇢ [gate ${event.gate} ${event.stepKey}] ${tag}${event.via === "llm" ? `（llm${event.score !== null ? ` score=${event.score}` : ""}）` : "（deterministic）"} — ${event.reason.slice(0, 140)}`);
  return { ...event, ok: bound.ok, approved: bound.ok, degraded: bound.degraded,
    reason: bound.ok ? event.reason : `${event.reason}；${bound.lineage?.errors.join("；") ?? "血缘未验证"}` };
}

/**
 * 读取**历史**阶段日志（同一 work-dir 的 `stages.jsonl`）。
 *
 * 为什么需要（2026-09-24 真机）：`--stages bgm,master` 这类"只重跑一段"的用法里，
 * 进程内 `records` 只有本次的两个环节，终审门因此误判"调色/字幕/弹幕没执行"。
 * 正确口径是看**产物血缘 + 历史裁决**：文件在、顺序对、历史里有放行记录，就算链路完整。
 */
function readStageHistory(): StageRecord[] {
  if (!existsSync(STAGE_LOG)) return [];
  return readFileSync(STAGE_LOG, "utf8").split("\n").filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) as StageRecord; }
    catch { throw new Error(`STAGE_LEDGER_INVALID: ${STAGE_LOG}:${index + 1}，先恢复有效账本再续跑`); }
  });
}
/**
 * 渲染 / 返工台账（T-2026-0930-0015）。
 *
 * 产品所有者口径（2026-09-30 真机复盘）：客户要能看到"**每一次花钱的账**"——
 * 提交了几次渲染、几次渲出后判不合格、几次被平台拒收（欠费/限额）、几次 canary 止损、
 * 后期各环节返工几次。只统计事实，不做费用估算（渲染单价未登记在仓库里）。
 */
interface RenderLedgerShot {
  shotId: string;
  /** 真的提交并拿到产物（或尝试渲染）的次数 */
  attempts: number;
  /** 渲出来后判不合格的次数 */
  rejected: number;
  /** 最近一次不合格原因（硬闸/监制/机检，取第一条） */
  lastReason: string | null;
  /** 平台拒收（未渲染）：欠费/限额等 */
  platformRejections: number;
  /** canary 止损中止（未渲染） */
  canaryAborts: number;
}
interface RenderLedger {
  generatedAt: string;
  projectId: string;
  totals: { renderAttempts: number; rendersRejected: number; platformRejections: number; canaryAborts: number; postStageRetries: number };
  shots: RenderLedgerShot[];
  postStages: Array<{ stage: string; retries: number; lastReason: string | null }>;
  notes: string[];
}
const RENDER_LEDGER_STAGES = ["material-gen", "shot"] as const;
const RENDER_LEDGER_POST_STAGES = ["compose", "color", "subtitle", "bgm", "cover", "mux", "master", "deliver"] as const;
function buildRenderLedger(history: StageRecord[]): RenderLedger {
  const byShot = new Map<string, RenderLedgerShot>();
  const postByStage = new Map<string, { stage: string; retries: number; lastReason: string | null }>();
  let platformRejections = 0;
  let canaryAborts = 0;
  for (const row of history) {
    const evidence = row.evidence ?? {};
    const errorText = String(evidence.error ?? "");
    const reasonText = String(
      (row.verdict?.hardFailures ?? [])[0] ?? row.verdict?.reason ?? row.note ?? evidence.reason ?? errorText ?? ""
    ).slice(0, 240);
    if ((RENDER_LEDGER_STAGES as readonly string[]).includes(row.stage) && row.invoked) {
      const shotId = String(row.shotId ?? "(unassigned)");
      const entry = byShot.get(shotId) ?? { shotId, attempts: 0, rejected: 0, lastReason: null, platformRejections: 0, canaryAborts: 0 };
      if (/AccountOverdue|限额|quota|insufficient/i.test(errorText)) {
        entry.platformRejections += 1;
        platformRejections += 1;
      } else if (errorText.startsWith("CANARY_ABORT")) {
        entry.canaryAborts += 1;
        canaryAborts += 1;
      } else {
        entry.attempts += 1;
        if (!row.ok) {
          entry.rejected += 1;
          entry.lastReason = reasonText || entry.lastReason;
        }
      }
      byShot.set(shotId, entry);
      continue;
    }
    if ((RENDER_LEDGER_POST_STAGES as readonly string[]).includes(row.stage) && row.invoked && !row.ok) {
      const current = postByStage.get(row.stage) ?? { stage: row.stage, retries: 0, lastReason: null };
      current.retries += 1;
      current.lastReason = reasonText || current.lastReason;
      postByStage.set(row.stage, current);
    }
  }
  const shots = [...byShot.values()].sort((a, b) => a.shotId.localeCompare(b.shotId));
  const postStages = [...postByStage.values()].sort((a, b) => a.stage.localeCompare(b.stage));
  return {
    generatedAt: stamp(),
    projectId: PROJECT,
    totals: {
      renderAttempts: shots.reduce((sum, entry) => sum + entry.attempts, 0),
      rendersRejected: shots.reduce((sum, entry) => sum + entry.rejected, 0),
      platformRejections,
      canaryAborts,
      postStageRetries: postStages.reduce((sum, entry) => sum + entry.retries, 0)
    },
    shots,
    postStages,
    notes: [
      "口径：渲染提交与打回次数来自本项目 stages.jsonl（material-gen / shot）；平台拒收与 canary 止损**不计入**渲染次数。",
      "只记次数与原因，不做费用估算（渲染单价未登记；客户可按自己与平台的结算口径折算）。"
    ]
  };
}
function renderLedgerMarkdown(ledger: RenderLedger): string {
  const lines = [
    `# 渲染与返工台账 · ${ledger.projectId}`,
    "",
    `生成时间：${ledger.generatedAt}`,
    "",
    "## 汇总",
    "",
    `- 提交渲染（含重试）：**${ledger.totals.renderAttempts}** 次`,
    `- 渲出后判不合格：**${ledger.totals.rendersRejected}** 次`,
    `- 平台拒收（未渲染，如欠费）：**${ledger.totals.platformRejections}** 次`,
    `- canary 止损中止（未继续渲染）：**${ledger.totals.canaryAborts}** 次`,
    `- 后期返工：**${ledger.totals.postStageRetries}** 次`,
    "",
    "## 逐镜",
    "",
    "| 镜号 | 渲染次数 | 判不合格 | 平台拒收 | canary 止损 | 最近原因 |",
    "|---|---:|---:|---:|---:|---|",
    ...(ledger.shots.length
      ? ledger.shots.map((shot) => `| ${shot.shotId} | ${shot.attempts} | ${shot.rejected} | ${shot.platformRejections} | ${shot.canaryAborts} | ${(shot.lastReason ?? "").replace(/\|/g, "／")} |`)
      : ["| （无渲染记录） | 0 | 0 | 0 | 0 | |"]),
    "",
    "## 后期返工",
    "",
    "| 环节 | 失败次数 | 最近原因 |",
    "|---|---:|---|",
    ...(ledger.postStages.length
      ? ledger.postStages.map((entry) => `| ${entry.stage} | ${entry.retries} | ${(entry.lastReason ?? "").replace(/\|/g, "／")} |`)
      : ["| （无返工记录） | 0 | |"]),
    "",
    "## 口径",
    "",
    ...ledger.notes.map((note) => `- ${note}`),
    ""
  ];
  return `${lines.join("\n")}\n`;
}
function historyApproved(history: StageRecord[], stage: string): boolean { return stageApproved(stage, [null], history); }
function lineageCheck(files: Array<{ label: string; path: string }>): { ok: boolean; detail: string } {
  const bindings: Record<string, string> = { raw: "compose", graded: "color", subtitled: "subtitle", danmaku: "danmaku", scored: "bgm", softsub: "mux" };
  const invalid = files.filter((file) => !artifactReusable(bindings[file.label] ?? file.label, file.path));
  return { ok: invalid.length === 0, detail: invalid.length ? `缺少当前哈希/最新通过裁决：${invalid.map((file) => file.label).join("、")}` : "各产物与当前源输入、配方及最近一次通过裁决一致" };
}
function preferDownstream(candidate: string, upstream: string, stage: string): string {
  return artifactReusable(stage, candidate, upstream) ? candidate : upstream;
}

/* ================= 媒体工具 ================= */

function run(bin: string, args: string[]): string {
  return execFileSync(bin, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}
/**
 * 文件指纹（素材镜溯源用）：素材与产物的 sha256 必须能证明"产物不是素材本身"。
 * 读盘失败时抛错（不许返回空串——空串会伪装成"指纹齐备"）。
 */
function sha256FileSync(file: string): string {
  const before = statSync(file), fd = openSync(file, "r"), digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes = 0;
    do {
      bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (bytes > 0) digest.update(buffer.subarray(0, bytes));
    } while (bytes > 0);
  } finally { closeSync(fd); }
  const after = statSync(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
    throw new Error(`HASH_SOURCE_CHANGED_DURING_READ: ${file}`);
  }
  return digest.digest("hex");
}
function probe(file: string): Record<string, unknown> {
  try {
    const raw = run(FFPROBE, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
    const json = JSON.parse(raw) as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
    const video = (json.streams ?? []).find((s) => s.codec_type === "video");
    const audio = (json.streams ?? []).find((s) => s.codec_type === "audio");
    return {
      duration: Number(json.format?.duration ?? 0),
      width: Number(video?.width ?? 0),
      height: Number(video?.height ?? 0),
      /** 帧率：`r_frame_rate` 形如 "24/1"，取分子/分母（早先写成连除，得到 1/24，监制据此误判"帧率异常"） */
      fps: (() => {
        const [num, den] = String(video?.r_frame_rate ?? "0/1").split("/").map(Number);
        return num && den ? num / den : 0;
      })(),
      vcodec: video?.codec_name ?? null,
      acodec: audio?.codec_name ?? null,
      hasAudio: Boolean(audio),
      bytes: statSync(file).size
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message.slice(0, 200) : String(err) };
  }
}
function runCli(cli: string, args: string[]): { ok: boolean; out: string } {
  try {
    /**
     * TypeScript 工具（`.ts/.mts`，例如 `compose-film.mts`）必须经 tsx 载入器运行：
     * 本工具的其它工位都是 `.mjs`（plain node 即可），但 TS 工具里会出现 `import "./x.js"`
     * 指向同名 `.ts` 的写法——plain node 解析不了，会报 `ERR_MODULE_NOT_FOUND`。
     * 2026-09-27 真机：`compose` 阶段（唯一走 .mts 的工位）因 #191 新增 `av-sync.js` 导入而整段失败，
     * 却因为磁盘上还留着上一版母版而"看起来跑过了"（旧声轨被继续使用——双声事故能存活到交付的第二个原因）。
     */
    const outIndex = args.indexOf("--out");
    if (outIndex >= 0 && args[outIndex + 1]) {
      const target = resolve(args[outIndex + 1]!);
      const inputIndex = args.indexOf("--in");
      if (inputIndex >= 0 && resolve(args[inputIndex + 1] ?? "") === target) throw new Error("TOOL_OUTPUT_OVERWRITES_INPUT");
      if (existsSync(target)) renameSync(target, `${target}.previous-${RUN_ID}-${randomUUID()}`);
    }
    const isTypeScriptCli = /\.m?ts$/i.test(cli);
    const out = execFileSync(process.execPath, isTypeScriptCli ? ["--import", "tsx", abs(cli), ...args] : [abs(cli), ...args], {
      encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
      /**
       * 工位路径监狱（2026-09-24 真机修复）：调色/配乐工位默认只允许访问 `process.cwd()` 与 tmpdir。
       * 本工具的产物根在工作区之外（项目less 会话目录），不显式放开会被 `path_not_allowed` 拒掉
       * （真机：调色直接失败）。这里把仓库根、运行产物根、交付目录与 tmpdir 一起写进白名单。
       */
      env: {
        ...process.env,
        WL_FFMPEG: FFMPEG,
        WL_FFPROBE: FFPROBE,
        FFMPEG_PATH: FFMPEG,
        FFPROBE_PATH: FFPROBE,
        WORKLOOM_BGM_FFMPEG_PATH: process.env.WORKLOOM_BGM_FFMPEG_PATH || FFMPEG,
        WORKLOOM_BGM_FFPROBE_PATH: process.env.WORKLOOM_BGM_FFPROBE_PATH || FFPROBE,
        WORKLOOM_SUBTITLE_FFMPEG_PATH: process.env.WORKLOOM_SUBTITLE_FFMPEG_PATH || FFMPEG,
        WORKLOOM_SUBTITLE_FFPROBE_PATH: process.env.WORKLOOM_SUBTITLE_FFPROBE_PATH || FFPROBE,
        WORKLOOM_POST_FFMPEG_PATH: process.env.WORKLOOM_POST_FFMPEG_PATH || FFMPEG,
        WORKLOOM_POST_FFPROBE_PATH: process.env.WORKLOOM_POST_FFPROBE_PATH || FFPROBE,
        WL_REPO_ROOT: REPO_ROOT,
        WORKLOOM_COLOR_ALLOWED_ROOTS: CLI_ALLOWED_ROOTS,
        WORKLOOM_SUBTITLE_ALLOWED_ROOTS: CLI_ALLOWED_ROOTS,
        WORKLOOM_BGM_ALLOWED_ROOTS: BGM_ALLOWED_ROOTS,
        WORKLOOM_VISUAL_ALLOWED_ROOTS: CLI_ALLOWED_ROOTS,
        /** 配音工位同样有路径监狱（配音写新文件、读原片），产物根/交付目录要显式放开 */
        WORKLOOM_VOICE_ALLOWED_ROOTS: CLI_ALLOWED_ROOTS
      }
    });
    return { ok: true, out };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: `${e.stdout ?? ""}\n${e.stderr ?? e.message ?? ""}`.slice(-1500) };
  }
}
const SUBTITLE_CLI = join(REPO_ROOT, "bundles/ai-video/connectors/subtitle-bridge/cli.mjs");
const COLOR_CLI = join(REPO_ROOT, "bundles/ai-video/connectors/color-bridge/cli.mjs");
const BGM_CLI = join(REPO_ROOT, "bundles/ai-video/connectors/bgm-bridge/cli.mjs");
const VOICE_CLI = join(REPO_ROOT, "bundles/ai-video/connectors/voice-bridge/cli.mjs");

/**
 * 重试指令（2026-09-24「反复重跑烧额度」根因修复）。
 *
 * 事故：SC-02 连烧 5 次渲染仍不过——因为第 2 次尝试提交的是**与第 1 次一字不差的提示词**，
 * 只换了 seed，本质是"重采样碰运气"。而监制每轮都给了具体问题与建议，这些信息**没有被用上**。
 * 现在：把上一轮 verdict 的 issues/suggestions 显式写进重跑提示词，并按次数给出升级动作。
 */
function retryInstruction(verdict: ProducerVerdict | null, attempt: number, maxAttempts: number): string {
  /**
   * 长度上限（2026-09-24 真机）：监制的 issues/suggestions 可能很长（一次给了 9 条、每条上百字），
   * 直接拼进重跑提示词会把多模态评审请求撑到 **HTTP 413（payload too large）**，
   * 于是监制不可用 → 又触发一次重渲（白烧额度）。这里按条裁断 + 总量封顶。
   */
  const clip = (text: string, max = 110) => (text.length > max ? `${text.slice(0, max)}…` : text);
  const issues = (verdict?.issues ?? []).filter(Boolean).slice(0, 3).map((item) => clip(item));
  const suggestions = (verdict?.suggestions ?? []).filter(Boolean).slice(0, 3).map((item) => clip(item));
  const reason = clip(String(verdict?.reason ?? "未给出理由"), 90);
  return [
    `【重跑要求·第 ${attempt}/${maxAttempts} 次】上一版未过监制：${reason}`,
    ...issues.map((item) => `必须修复：${item}`),
    ...suggestions.map((item) => `按建议修改：${item}`),
    attempt >= maxAttempts
      ? "本次为最后一次尝试：若仍不达标，将按「带瑕疵放行 + badcase 归档」处理，不再重复烧额度。"
      : "注意：同一问题第二次出现说明是分镜设计问题（机位/动作/朝向），优先改设计而不是继续加形容词。",
    "输出仍须满足：人物与定妆照同一张脸、肢体与手指结构正确、空间物理自洽（桥/台阶有落点）。"
  ].join("\n");
}

/* ================= 输入 ================= */

interface ShotCard {
  shotId: string; sceneType?: string; duration?: number;
  scene?: string; sceneDescription?: string; action?: string; character?: string; costume?: string;
  policyTags?: string[]; speechMode?: "on-camera" | "voice-over"; speechScene?: string;
  makeup?: string; composition?: string; lighting?: string; color_palette?: string; mood?: string;
  dialogue?: Array<{ speaker?: string; text?: string; emotion?: string; trigger?: string }>;
  [key: string]: unknown;
}
const shotlist = structuredClone(sourceDocument) as {
  projectId?: string; title?: string; durationSeconds?: number; aspect?: string; resolution?: string;
  sceneBible?: SceneBible;
  videoType?: string;
  logline?: string;
  scenePolicy?: { id?: string; exceptions?: Array<{ rule: "restricted-location" | "restricted-costume"; shotId: string; term: string; customerRequest: string; source: string }> };
  hook?: HookCard;
  character?: { id?: string; name?: string }; shots: ShotCard[];
};
// Reconcile provider-success bytes before any generation qualification or creative-card audit.
const initialShots = (ONLY.length ? shotlist.shots.filter(shot => ONLY.includes(shot.shotId)) : shotlist.shots);
const cachedProviderSources = new Map<string, NonNullable<ReturnType<typeof findProviderClip>>>();
const adoptedRenderedClips = new Set<string>();
for (const shot of initialShots) {
  const paid = reusableProviderClip(shot, [join(CLIP_DIR, `${shot.shotId}.raw.mp4`), join(CLIP_DIR, `${shot.shotId}.mp4`)]);
  if (paid) cachedProviderSources.set(shot.shotId, paid);
}
const PREPRODUCTION_STAGES = new Set(["cine-kb", "continuity", "micromotion", "spec", "plates"]);
const requestedPreparation = [...STAGES].some(stage => PREPRODUCTION_STAGES.has(stage) || stage === "videos" || stage === "material-gen");
const pendingGenerationIds = new Set(initialShots.filter(shot => !cachedProviderSources.has(shot.shotId)).map(shot => shot.shotId));
const NEEDS_PREPRODUCTION = !POST_ONLY_ASSEMBLY && requestedPreparation && pendingGenerationIds.size > 0;
const requiresGeneration = (shot: { shotId: string }): boolean => NEEDS_PREPRODUCTION && pendingGenerationIds.has(shot.shotId);
const generationStageEnabled = (stage: string): boolean => STAGES.has(stage) && NEEDS_PREPRODUCTION;
const ROUTE_FILE = arg("--route", "");
const ROUTE_KIND_ARG = arg("--route-kind", "");
const routeBrief: unknown = BRIEF_FILE && existsSync(abs(BRIEF_FILE))
  ? (() => {
    try {
      return JSON.parse(readFileSync(abs(BRIEF_FILE), "utf8"));
    } catch (error) {
      throw new Error(`ROUTE_BRIEF_UNREADABLE: --brief 不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`);
    }
  })()
  : undefined;
const routeRecord: unknown = NEEDS_PREPRODUCTION && ROUTE_FILE
  ? (() => {
    if (!existsSync(abs(ROUTE_FILE))) {
      throw new Error(`ROUTE_FILE_MISSING: --route ${ROUTE_FILE} 不存在；先跑 scripts/tools/route-video.mts --out ${ROUTE_FILE}`);
    }
    try {
      return JSON.parse(readFileSync(abs(ROUTE_FILE), "utf8"));
    } catch (error) {
      throw new Error(`ROUTE_FILE_UNREADABLE: --route 不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`);
    }
  })()
  : undefined;
const ROUTE_PRODUCT_ANCHOR = detectProductAnchor({ brief: routeBrief, shotlist: sourceDocument });
const ROUTE_PREFLIGHT: RoutePreflightResult = (() => {
  if (!NEEDS_PREPRODUCTION) return { kind: ROUTE_KIND_ARG === "marketing" || sourceDocument.pipeline === "marketing" ? "marketing" : "narrative",
    source: "explicit", productAnchor: ROUTE_PRODUCT_ANCHOR, notes: ["已有成功片段直接后期；不重做生成前分流/商品资格"], record: null };
  try {
    return resolveRoutePreflight({ routeRecord, routeKind: ROUTE_KIND_ARG, productAnchor: ROUTE_PRODUCT_ANCHOR });
  } catch (error) {
    if (error instanceof RoutePreflightError) {
      log(`⛔ 分流前置检查未通过（${error.code}）：`);
      for (const line of error.message.split("\n")) log(`　　${line}`);
      throw new Error(`ROUTE_PREFLIGHT_${error.code}: ${error.message.split("\n")[0]}`);
    }
    throw error;
  }
})();
log(`✅ 分流前置：${ROUTE_PREFLIGHT.kind}（来源：${ROUTE_PREFLIGHT.source}）`
  + `${ROUTE_PREFLIGHT.productAnchor ? ` · 商品锚点「${ROUTE_PREFLIGHT.productAnchor}」` : ""}`);

if (!NEEDS_PREPRODUCTION) {
  for (const stage of [...STAGES].filter(stage => PREPRODUCTION_STAGES.has(stage))) {
    const aliases: Record<string, string> = { spec: "prompt-review", plates: "keyframe" };
    for (const shot of stage === "plates" ? initialShots : [null]) record({ stage: aliases[stage] ?? stage,
      shotId: shot?.shotId ?? null, invoked: false, ok: true, cached: Boolean(cachedProviderSources.size), degraded: false,
      attempt: 0, ms: 0, artifact: null, evidence: { applicable: false, skipReason: "现有成功渲染进入正式后期；不重做生成资格或创作卡审查", qualityReviewed: false }, verdict: null });
  }
}
// 核对完整源片，而非--only选中的一镜；任何漂移都在付费调用之前拦住。
if (NEEDS_PREPRODUCTION && sourceDocument.schemaVersion === "workloom.film-shotlist/v1" && sourceDocument.pipeline === "marketing") {
  const proof = sourceDocument.marketingFacts as { root?: string; ref?: string; sha256?: string; scope?: MarketingScope } | undefined;
  if (!proof || typeof proof.root !== "string" || typeof proof.ref !== "string" || typeof proof.sha256 !== "string"
    || proof.scope?.projectId !== PROJECT || !Array.isArray(sourceDocument.shots)) throw new Error("MARKETING_FACTS_REQUIRED：正式营销成片缺本项目完整最终事实资格");
  await verifyMarketingFacts({ root: proof.root, ref: proof.ref, sha256: proof.sha256, scope: proof.scope,
    shots: sourceDocument.shots.map(shot => ({ shotId: String(shot.shotId), prompt: String(shot.prompt), fields: shot })),
    sceneBible: sourceDocument.sceneBible as SceneBible | undefined });
}

const policyBrief: Record<string, unknown> | null = BRIEF_FILE ? (() => {
  const file = abs(BRIEF_FILE);
  if (!existsSync(file)) throw new Error(`--brief 指向的文件不存在：${file}`);
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`--brief 必须是 JSON 对象：${file}`);
  return value as Record<string, unknown>;
})() : null;
const scenePolicies = NEEDS_PREPRODUCTION ? loadScenePolicies(join(REPO_ROOT, "bundles/ai-video/library/scene-policies")) : [];
const scenePolicySelection = NEEDS_PREPRODUCTION ? selectScenePolicy(shotlist, policyBrief, scenePolicies) : { policy: null, reason: "已有成功渲染直接进入正式后期；生成前片型审计不适用" };
const scenePolicy = scenePolicySelection.policy;
if (scenePolicy && (ACCEPT_REJECTED.length > 0 || flag("--accept-env-defects"))) {
  throw new Error(`${scenePolicy.id} 片型的品质底线不得用 --accept-rejected / --accept-env-defects 绕过；请修复或登记客户特殊场景例外`);
}
const SCENE_POLICY_REPORT_FILE = join(WORK_DIR, `scene-policy-report-${PROJECT}.json`);
let scenePolicyReport: ScenePolicyReport | null = NEEDS_PREPRODUCTION && scenePolicy ? auditScenePolicy(shotlist, scenePolicy) : null;
if (scenePolicyReport) scenePolicyReport.policy.selection = scenePolicySelection.reason;
const writeScenePolicyReport = (): void => {
  writeFileSync(SCENE_POLICY_REPORT_FILE, `${JSON.stringify(scenePolicyReport ?? {
    schemaVersion: "workloom.scene-policy-report/v1", policy: null, selection: scenePolicySelection.reason, passed: true
  }, null, 2)}\n`, "utf8");
};
writeScenePolicyReport();
/**
 * post-only 组装（T-2026-0929-0012）：片型门是生成前/生成后的**创作口径**检查，
 * 本模式不生成新镜头 → 未命中时按**已声明降级**记账（`degraded + assemblyMode=post-only`），
 * 后续收尾检查不会把它当成"请求未完成"（否则片子已交付、退出码却是 6，误导自动化）。
 */
const scenePolicyDeclaredDegraded = POST_ONLY_ASSEMBLY && scenePolicyReport !== null && !scenePolicyReport.passed;
/**
 * 分流结论留痕（T-2026-0930-0015）：`--route` / `--route-kind` 的结论与来源写进阶段账本，
 * 交付清单同样带 `route` 字段——审计能回答"这条片子当时按哪条管线做的、商品锚点是什么"。
 */
record({
  stage: "route", shotId: null, invoked: true, ok: true, cached: false, degraded: false, attempt: 1, ms: 0,
  artifact: ROUTE_FILE ? abs(ROUTE_FILE) : null,
  evidence: {
    kind: ROUTE_PREFLIGHT.kind, source: ROUTE_PREFLIGHT.source,
    productAnchor: ROUTE_PREFLIGHT.productAnchor, notes: ROUTE_PREFLIGHT.notes,
    recordTitle: ROUTE_PREFLIGHT.record ? String(ROUTE_PREFLIGHT.record.title ?? "") : null
  },
  verdict: null, note: `视频类型：${ROUTE_PREFLIGHT.kind}（${ROUTE_PREFLIGHT.source}）`
});
record({ stage: "scene-policy-audit", shotId: null, invoked: true, ok: scenePolicyReport?.passed ?? true,
  cached: false, degraded: scenePolicyDeclaredDegraded, attempt: 1, ms: 0, artifact: SCENE_POLICY_REPORT_FILE,
  evidence: { policy: scenePolicy?.id ?? null, version: scenePolicy?.version ?? null,
    sourceSha256: scenePolicy?.sourceSha256 ?? null, selection: scenePolicySelection.reason,
    defects: scenePolicyReport?.defects ?? [], ratios: scenePolicyReport?.ratios ?? null,
    ...(scenePolicyDeclaredDegraded ? { assemblyMode: "post-only" } : {}) }, verdict: null });
if (scenePolicy && scenePolicyReport && !scenePolicyReport.passed) {
  /**
   * post-only 组装（T-2026-0929-0012）：片型门是**生成前**门（管"别拍跑偏的片子"），
   * 而本模式不生成任何新镜头、只是把已有成品片段走完整后期链——因此降级为**告警 + 门记录**，
   * 不阻断；真正的把关点在 cover/deliver（平台规范、差异实测）与人工验收。
   */
  const defects = scenePolicyReport.defects.map((item) => `${item.shotId ?? "全片"}[${item.rule}] ${item.detail}`);
  if (POST_ONLY_ASSEMBLY) {
    log(`⚠ ${scenePolicy.title} 生成前门禁未通过（${scenePolicyReport.defects.length} 项），但本片为 post-only 组装（不生成新镜头）→ 记为 degraded，不阻断`);
    for (const defect of defects.slice(0, 6)) log(`   · ${defect}`);
    recordGate({
      stepKey: "g-post-only-assembly",
      sourceStage: "scene-policy",
      checks: [{ id: "scene-policy-degraded", pass: true, hard: false, detail: `片型门 ${scenePolicy.id} 未通过 ${scenePolicyReport.defects.length} 项：${defects.slice(0, 6).join("；")}` }],
      shotIds: sourceDocument.shots.map((shot) => String(shot.shotId)),
      degraded: true,
      reason: `post-only 组装：片型生成前门降级（${scenePolicyReport.defects.length} 项）`,
      evidence: { assemblyMode: "post-only", policy: scenePolicy.id, defects: scenePolicyReport.defects, ratios: scenePolicyReport.ratios }
    });
  } else {
    log(`⛔ ${scenePolicy.title} 生成前门禁未通过（${scenePolicyReport.defects.length} 项）：${defects.join("；")}`);
    process.exit(7);
  }
}
const editorialIds = editorialShotIds({ shotIds: shotlist.shots.map(row => row.shotId), exclude: EDIT_EXCLUDE,
  postOnly: POST_ONLY_ASSEMBLY, reason: POST_ONLY_REASON });
const shotsSelected = shotlist.shots.filter(s => editorialIds.includes(s.shotId) && (!ONLY.length || ONLY.includes(s.shotId)));
if (!Array.isArray(shotsSelected) || shotsSelected.length === 0) throw new Error("shotlist 里没有镜头");

/* ================= 场景圣经 · 环境真实性（2026-09-27 真机事故 → 机制化） ================= */

/**
 * 事故：销售口播片 8 镜**全部通过监制**，但产品所有者一眼看出"空间布景不像实拍"。
 * 逐镜取证：8/8 缺空间实指与使用痕迹、7/8 灯光只有柔光箱/反光板这类棚具语言、材质全是一级名词。
 * 根因不是模型，是**管线里没有任何"环境真实性"判据**：模型收到"现代简约商务空间"这类空词时，
 * 只能落回训练分布里的**平均办公室**——平均化就是"AI 感"。
 *
 * 本节的机制（三件，缺一不可）：
 *   ① **展开**：片级 `sceneBible` 展开进每镜既有字段（scene/sceneDescription/lighting/props），
 *      关键帧提示词与视频提示词因此都吃到空间实指、材质工艺、实用光源、使用痕迹与道具交互；
 *   ② **审计**：`environmentDefects` 逐镜出硬/软缺陷，写 `env-realism-report-<project>.json` 留证；
 *   ③ **闸门**：本轮要做生成类阶段（spec/plates/material-gen/videos）时，硬缺陷 **fail-closed**
 *      ——"渲染前拦住"而不是"渲完肉眼发现"（单镜关键帧 ~85s、单镜视频 ~160s、还要重后期）。
 *      正式生产不可豁免；dry-run 可生成带明确降级标记的诊断记录。
 *
 * 纪律：圣经只升级**环境**，不改表演/台词/时长/构图（`expandShotWithBible` 的字段白名单）。
 */
const baseShots: ShotCard[] = sceneBible
  ? shotsSelected.map((shot) => requiresGeneration(shot) ? expandShotWithBible(shot as ShotCard & Record<string, unknown>, sceneBible) : shot)
  : shotsSelected;
const shots: ShotCard[] = scenePolicy ? baseShots.map((shot) => requiresGeneration(shot) ? applyScenePolicy(shot, scenePolicy) : shot) : baseShots;
const COMPOSE_TAIL_HOLDS = parseClipTailHolds(arg("--compose-tail-holds"), shots.length);
const COMPOSE_HOLDS_BY_SHOT = new Map(shots.map((shot, index) => [shot.shotId, COMPOSE_TAIL_HOLDS[index]!]));
let POST_SHOT_ORDER = shots.map(shot => shot.shotId);
let POST_END_CARD_SECONDS = END_CARD_SECONDS;
const postShots = (): ShotCard[] => POST_SHOT_ORDER.map(id => shots.find(shot => shot.shotId === id)!);
const REAL_PERSON_LIBRARY = resolve(arg("--real-person-library", join(REPO_ROOT, "bundles/ai-video/library/real-person-assets")));
const realPersonLibrary: ReturnType<typeof loadRealPersonAssets> = NEEDS_PREPRODUCTION
  ? loadRealPersonAssets(REAL_PERSON_LIBRARY) : { root: REAL_PERSON_LIBRARY, assets: [], byAssetId: new Map() };
const realPersons = new Map<string, (typeof realPersonLibrary.assets)[number]>();
for (const shot of (sourceDocument.shots ?? []).filter(shot => requiresGeneration({ shotId: String(shot.shotId) }))) {
  if (shot.assetRef === undefined) continue;
  if (!isRealPersonAssetRef(shot.assetRef)) throw new Error(`REAL_PERSON_REFERENCE_INVALID：${String(shot.shotId)}`);
  const entry = realPersonLibrary.byAssetId.get(assetIdOf(shot.assetRef));
  if (!entry) throw new Error(`REAL_PERSON_UNREGISTERED：${String(shot.shotId)}引用不在真人主档`);
  const defects = [...entry.issues, ...assertShotMatchesCertifiedAsset(shot, entry.asset)].filter(issue => issue.hard);
  if (defects.length) throw new Error(`REAL_PERSON_INVALID：${defects.map(issue => issue.detail).join("；")}`);
  realPersons.set(String(shot.shotId), entry);
  record({ stage: "real-person-source", shotId: String(shot.shotId), invoked: true, ok: true, cached: false, degraded: false,
    attempt: 1, ms: 0, artifact: join(entry.dir, "profile.json"),
    evidence: realPersonUsageReceipt({ asset: entry.asset, projectId: PROJECT, shots: [String(shot.shotId)] }), verdict: null });
}

for (const shot of shots.filter(requiresGeneration)) {
  if (!shot.productRef) continue;
  const id = typeof shot.productRef === "string" ? shot.productRef : String((shot.productRef as { id?: string }).id ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new Error("PRODUCT_REFERENCE_INVALID");
  const entry = loadProductArchive(join(REPO_ROOT, "bundles/ai-video/library/products", id), {
    probeImage: file => { const info = probe(file); return { width: Number(info.width), height: Number(info.height) }; },
  });
  const hero = entry && productHeroPhoto(entry.archive);
  if (!entry || !hero || entry.issues.some(issue => issue.hard) || abs(String(shot.photo)) !== productPhotoPath(entry, hero)
    || shot.productPhotoSha256 !== hero.sha256) throw new Error(`PRODUCT_REFERENCE_CHANGED：${shot.shotId}的实际原图与登记主图不一致`);
}

/** 只有"要花钱生成"的阶段才让环境审计 fail-closed；纯后期复跑（compose/subtitle/mux…）不拦 */
const ENV_AUDIT_STAGES = ["spec", "plates", "material-gen", "videos"] as const;
const envAuditInScope = NEEDS_PREPRODUCTION && ENV_AUDIT_STAGES.some((stage) => STAGES.has(stage));
const envBibleIssues = sceneBible ? validateSceneBible(sceneBible) : [];
const envDefects: EnvDefect[] = environmentDefects(baseShots.filter(requiresGeneration), sceneBible);
const envSummary = summarizeDefects(envDefects);
/**
 * 设备口径：新项目默认当前故事日期并冻结，历史场景/品牌要求由源合同明确声明。
 * 与环境审计同一处 fail-closed——都是"渲染前必须清零"的资产级约束，报告合并在一份文件里（便于一条命令复核）。
 */
const devDefects: DeviceDefect[] = deviceDefects(shots.filter(requiresGeneration), { eraProfile: authorContext.eraProfile });
const devSummary = summarizeDeviceDefects(devDefects);
const envHardTotal = envSummary.hard + devSummary.hard;
const envSoftTotal = envSummary.soft + devSummary.soft;
const ENV_REPORT_FILE = join(WORK_DIR, `env-realism-report-${PROJECT}.json`);
mkdirSync(WORK_DIR, { recursive: true });
writeFileSync(ENV_REPORT_FILE, `${JSON.stringify({
  schemaVersion: "workloom.env-realism-report/v2",
  eraProfile: authorContext.eraProfile,
  generatedAt: stamp(),
  shotlist: SHOTS_FILE,
  projectId: PROJECT,
  sceneBible: sceneBible
    ? { spaceId: sceneBible.spaceId, summary: spaceSummary(sceneBible), materials: sceneBible.materials?.length ?? 0, practicalLights: sceneBible.practicalLights?.length ?? 0, traces: sceneBible.traces?.length ?? 0, issues: envBibleIssues }
    : null,
  summary: { hard: envHardTotal, soft: envSoftTotal, byRule: { ...envSummary.byRule, ...devSummary.byRule }, environment: envSummary, device: devSummary },
  devicePolicy: { version: DEVICE_POLICY_VERSION, verifiedAt: DEVICE_POLICY_VERIFIED_AT, eraProfile: authorContext.eraProfile, brief: "按冻结故事年代、逐镜具体型号及显式品牌档案核实；局部时代合同可覆写" },
  perShot: shots.map((shot) => {
    const own = [...envDefects, ...devDefects].filter((defect) => defect.shotId === shot.shotId);
    return {
      shotId: shot.shotId,
      hard: own.filter((defect) => defect.hard).length,
      soft: own.filter((defect) => !defect.hard).length,
      rules: own.map((defect) => `${defect.rule}${defect.hard ? "" : "(软)"}`),
      detail: own.map((defect) => defect.detail)
    };
  }),
  defects: [...envDefects, ...devDefects]
}, null, 2)}\n`, "utf8");

log(`环境真实性审计：${sceneBible ? `场景圣经 ${sceneBible.spaceId}（${spaceSummary(sceneBible)}）` : "未提供场景圣经（片级 sceneBible / --scene-bible）"}`);
if (envBibleIssues.length > 0) log(`  ⚠ 圣经自身待完善（软）：${envBibleIssues.join("；")}`);
log(`  环境：硬缺陷 ${envSummary.hard} · 软提示 ${envSummary.soft}｜设备口径（${DEVICE_POLICY_VERSION}）：硬缺陷 ${devSummary.hard} · 软提示 ${devSummary.soft}`);
log(`  合计：硬缺陷 ${envHardTotal} · 软提示 ${envSoftTotal}｜规则：${Object.entries({ ...envSummary.byRule, ...devSummary.byRule }).map(([rule, count]) => `${rule}×${count}`).join(" · ") || "无"}`);
for (const defect of envDefects.filter((item) => item.hard)) log(`  ✗ ${defect.shotId} [${defect.rule}] ${defect.detail}`);
for (const defect of devDefects) log(`  ${defect.hard ? "✗" : "△"} ${defect.shotId} [${defect.rule}] ${defect.detail}`);
log(`  报告：${ENV_REPORT_FILE}`);

const envAccepted = ACCEPT_REJECTED.includes("env") || ACCEPT_REJECTED.includes("env-realism") || flag("--accept-env-defects");
record({
  stage: "env-audit", shotId: null, invoked: true,
  ok: envHardTotal === 0 || envAccepted || !envAuditInScope,
  cached: false,
  degraded: envHardTotal > 0 && envAccepted,
  attempt: 1, ms: 0, artifact: ENV_REPORT_FILE,
  evidence: {
    sceneBible: sceneBible ? sceneBible.spaceId : null,
    space: sceneBible ? spaceSummary(sceneBible) : null,
    bibleIssues: envBibleIssues,
    hard: envHardTotal, soft: envSoftTotal, byRule: { ...envSummary.byRule, ...devSummary.byRule },
    environment: { hard: envSummary.hard, soft: envSummary.soft },
    devicePolicy: { version: DEVICE_POLICY_VERSION, verifiedAt: DEVICE_POLICY_VERIFIED_AT, hard: devSummary.hard, soft: devSummary.soft },
    inScope: envAuditInScope, acceptedBy: envAccepted ? "ACCEPT_REJECTED(env)" : null,
    hardDefects: [...envDefects, ...devDefects].filter((item) => item.hard).map((item) => ({ shotId: item.shotId, rule: item.rule, detail: item.detail }))
  },
  verdict: null,
  note: "环境真实性 + 设备口径审计（场景圣经展开 + 确定性规则）"
});
if (envAuditInScope && envHardTotal > 0 && !envAccepted) {
  log("⛔ 环境真实性 / 设备口径硬缺陷未清零：本环节在花钱之前核对场景事实、器物用途与冻结年代。");
  log("   修法：在 shotlist 顶层写 sceneBible（或 --scene-bible <file>），让每镜带上空间、可见材质、实际光源和明确使用状态；");
  log("   可交互道具（手机/平板/笔记本）按用途补 propInteraction（prop / purpose / orientation / screenFacing / operatedBy）。");
  log(`   设备口径：每镜补 devices[]（category + model，机型见允许清单：${allowedModelSummary(undefined, authorContext.eraProfile)}…）——裸词不算机型。`);
  log("   按报告修复源合同后重跑；正式生产不接受豁免。");
  process.exit(7);
}

/* ================= 开场钩子 · 前 3 秒（2026-09-27 新增岗位/机制） ================= */

/**
 * 产品所有者口径：抖音类平台上，完播率的分水岭在**前 3 秒**。
 * 此前管线里没有"钩子"这个产物——片头设计师管的是片头镜头卡，音效只铺剪辑点（0–0.6s 空白），
 * 评审清单里也没有钩子类目，于是"开头三秒平平"没有任何机制能发现。
 *
 * 三段机制（与 `opening-hook.ts` 同源）：
 *   ① **钩子卡**（shotlist 顶层 `hook`，钩子设计师的产物）：type / promise / payoffShotId / 首镜模板 / 钩子音；
 *   ② **确定性判据**：类型在库内、承诺有兑现镜、音效落在 0–0.6s 窗口、首镜够长；
 *   ③ **钩子音效**：在 sfx 阶段把 0–0.6s 的钩子音铺上（短平台默认 impact，长视频默认 whoosh）。
 * 短平台缺钩子卡 = 硬失败（前 3 秒不许靠运气）；其余平台缺钩子卡 = 软提示。
 */
const PLATFORM = arg("--platform", "抖音/快手");
const hookCard: HookCard | null = shotlist.hook ?? null;
/**
 * 钩子判据必须看**整片**镜头卡，而不是 `--only` 过滤后的子集（2026-09-27 真机 v2 发现）：
 * 单镜补渲（`--stages plates --only CF-05`）时，兑现镜 CF-03 不在子集里 → 误报"兑现镜不存在"，
 * 把一次正常的补渲判成硬失败。首镜与兑现镜都是**片级**概念，口径应为完整 shotlist.shots。
 */
const hookChecks = NEEDS_PREPRODUCTION ? openingHookChecks({ shots: shotlist.shots, hook: hookCard, platform: PLATFORM }) : [];
const hookSummary = summarizeHookChecks(hookChecks);
/**
 * 钩子音效三条开关口径：显式关（`--no-hook-sfx`）> 显式开（`--hook-sfx`）> 有钩子卡即开。
 * 音色与落点：钩子卡声明优先，否则按平台给安全默认（`defaultHookSfx`）。
 */
const hookSfxEnabled = flag("--no-hook-sfx") ? false : (flag("--hook-sfx") || Boolean(hookCard));
const hookSfxSpec = hookCard?.sfx ?? defaultHookSfx(PLATFORM);
log(`开场钩子：${hookCard ? `${hookCard.type}（${HOOK_TYPE_LABELS[hookCard.type] ?? "未知类型"}）· 兑现镜 ${hookCard.payoffShotId}` : "未登记钩子卡"}`);
log(`  窗口：前 ${hookWindowFor(PLATFORM)}s｜判据：硬失败 ${hookSummary.hard} · 软提示 ${hookSummary.soft}｜钩子音：${hookSfxEnabled ? `${hookSfxSpec.kind}@${hookSfxSpec.atSec}s` : "关闭"}`);
for (const check of hookChecks) log(`  ${check.pass ? "✓" : "✗"} [${check.id}] ${check.detail}`);
const hookAccepted = ACCEPT_REJECTED.includes("hook");
record({
  stage: "hook-audit", shotId: null, invoked: true,
  ok: hookSummary.hard === 0 || hookAccepted, cached: false,
  degraded: hookSummary.hard > 0 && hookAccepted,
  attempt: 1, ms: 0, artifact: null,
  evidence: {
    platform: PLATFORM, windowSec: hookWindowFor(PLATFORM), hookSfxEnabled,
    hook: hookCard ? { type: hookCard.type, promise: hookCard.promise, payoffShotId: hookCard.payoffShotId, sfx: hookSfxSpec } : null,
    cardIssues: hookCard ? validateHookCard(hookCard) : [],
    checks: hookChecks, hard: hookSummary.hard, soft: hookSummary.soft,
    acceptedBy: hookAccepted ? "ACCEPT_REJECTED(hook)" : null
  },
  verdict: null,
  note: "开场钩子审计（类型库 / 承诺兑现 / 0–0.6s 钩子音窗口）"
});
if (hookSummary.hard > 0 && !hookAccepted) {
  log("⛔ 开场钩子硬失败：前 3 秒是短平台完播率的分水岭，不允许「靠运气」进流水线。");
  for (const check of hookSummary.hardFailures) log(`   · ${check.id}：${check.detail}`);
  log("   修法：在 shotlist 顶层写 hook{ type, promise, payoffShotId, firstShotTemplate{visual,line}, sfx{kind,atSec} }；");
  log("   确需带瑕疵继续：--accept-rejected hook（会记为 degraded 留痕）。");
  process.exit(8);
}
/**
 * 平台语速门（T-2026-0930-0005）：把"抖音的语速要明显更快"从形容词变成可机检的判据。
 *
 * 起因（产品所有者 2026-09-30 口径）：客户对抖音快节奏的感知就是"说话语速要明显更快"，
 * 而此前全链路只有一个全局语速口径（3.5 字/秒，仅在 prd-specialist / hook-designer 的提示词里），
 * 平台维度完全没有；"念得完"也不在任何门里核过——长文案配短镜会一路跑到配音才暴露。
 *
 * 口径与数值来源：`packages/video-studio/src/platform-intent.ts#SPEECH_RATE_POLICY`
 * （抖音 4.8 目标 / 5.6 上限；长视频沿用既有 3.5 / 4.2）。
 * 判据输入是**完整 shotlist.shots**，与钩子门同口径：`--only` 补渲不能改变语速判据的输入。
 * 语速靠"文案写得更紧"，不靠 atempo 硬拉（voice-bridge fitTempo 上限 1.25 不动）。
 */
const speechProfile = speechRateProfile(PLATFORM);
const speechRows = shotlist.shots.filter(requiresGeneration).map((shot) => ({
  shotId: String(shot.shotId ?? ""),
  fit: checkSpeechFit({
    shotId: String(shot.shotId ?? ""),
    text: dialogueText(shot),
    durationSec: Number(shot.duration),
    profile: speechProfile,
  }),
}));
const speechOver = speechRows.filter((row) => row.fit.severity === "over");
const speechLoose = speechRows.filter((row) => row.fit.severity === "loose");
/** 时长缺失/非法按"无法判定"处理，计软提示——时长本身另有门管，不在本门重复判死。 */
const speechUnknown = speechRows.filter((row) => row.fit.severity === "invalid");
const speechMeasured = speechRows.filter((row) => row.fit.units > 0);
const speechAccepted = ACCEPT_REJECTED.includes("speech-rate");
log(`平台语速：${PLATFORM} → ${speechProfile.tier} 档（目标 ${speechProfile.target} · 上限 ${speechProfile.max} 字/秒 · 配音基础速率 ${speechProfile.ttsSpeed}×）`);
log(`  台词镜 ${speechMeasured.length} 个｜念不完 ${speechOver.length} · 节奏偏松 ${speechLoose.length} · 无法判定 ${speechUnknown.length}`);
for (const row of speechOver) log(`  ✗ [${row.shotId}] ${row.fit.detail}`);
for (const row of speechLoose) log(`  · [${row.shotId}] ${row.fit.detail}`);
record({
  stage: "speech-rate", shotId: null, invoked: true,
  ok: speechOver.length === 0 || speechAccepted, cached: false,
  degraded: speechOver.length > 0 && speechAccepted,
  attempt: 1, ms: 0, artifact: null,
  evidence: {
    platform: PLATFORM, profile: speechProfile,
    measured: speechMeasured.length, over: speechOver.length, loose: speechLoose.length, unknown: speechUnknown.length,
    rows: speechRows.map((row) => ({ shotId: row.shotId, units: row.fit.units, unitsPerSecond: row.fit.unitsPerSecond, severity: row.fit.severity })),
    acceptedBy: speechAccepted ? "ACCEPT_REJECTED(speech-rate)" : null
  },
  verdict: null,
  note: "平台语速门（逐镜按镜时长折算可念字数；超上限判念不完）"
});
if (speechOver.length > 0 && !speechAccepted) {
  log("⛔ 平台语速硬失败：台词在镜时长内念不完，配音阶段才发现会直接毁掉节奏与对齐。");
  log(`   修法（择一）：① 把文案改写到「镜时长 × ${speechProfile.max} 字」以内；② 加长该镜时长；③ 拆成两镜。`);
  log("   禁止把配音速率拉上去硬塞（voice-bridge fitTempo 上限 1.25 不得上调）；");
  log("   确需带瑕疵继续：--accept-rejected speech-rate（会记为 degraded 留痕）。");
  process.exit(9);
}
/** 只计算真实存在的刀口；单镜片不能进入 compose 的逐刀转场分支。 */
const EFFECTIVE_CUT_TRANSITION = shots.length > 1 ? CUT_TRANSITION : "";
const EFFECTIVE_CUT_TRANSITION_AT = CUT_TRANSITION_AT.trim()
  ? [...new Set(CUT_TRANSITION_AT.split(",").map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value >= 2 && value <= shots.length))].join(",")
  : "";
const CUT_TRANSITION_COUNT = !EFFECTIVE_CUT_TRANSITION ? 0
  : CUT_TRANSITION_AT.trim() ? EFFECTIVE_CUT_TRANSITION_AT.split(",").filter(Boolean).length : shots.length - 1;
const transitionLoss = Number((CUT_TRANSITION_COUNT * CUT_TRANSITION_DURATION).toFixed(3));
const plannedPostSeconds = shots.reduce((sum, s) => sum + Number(s.duration ?? 0), 0) + END_CARD_SECONDS;
const totalSeconds = Number(shotlist.durationSeconds ?? plannedPostSeconds);
if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) throw new Error("FILM_DURATION_TARGET_INVALID");
/**
 * 创作目标用于预算和观测；compose 后以真实完整镜头时间轴驱动字幕、配乐和音效。
 * 源镜头保持原速度和完整帧，额外引导卡有独立的时间段。
 */
let expectedMasterSeconds = plannedPostSeconds;
const POST_SECONDS_BY_SHOT = new Map<string, number>();
const postShotSeconds = (shot: ShotCard): number => POST_SECONDS_BY_SHOT.get(shot.shotId) ?? Number(shot.duration ?? 5);
/** 剪辑网格（真实切点，秒）：配乐卡点与 BPM 反推的事实依据（去掉片尾那一个点） */
let CUT_GRID: number[] = (() => {
  /** Compose 的真实完整镜头回执在后期开始前覆盖这个规划网格。 */
  const durations = shots.map((shot) => Number(shot.duration ?? 5));
  if (END_CARD_SECONDS) durations.push(END_CARD_SECONDS);
  const transitionAt = EFFECTIVE_CUT_TRANSITION
    ? EFFECTIVE_CUT_TRANSITION_AT.split(",").map((value) => Number(value.trim())).filter((value) => Number.isFinite(value) && value > 0)
    : [];
  return cutTimesFromShots(durations, EFFECTIVE_CUT_TRANSITION ? CUT_TRANSITION_DURATION : 0, transitionAt);
})();

/**
 * **素材镜**（2026-09-25 口径修订，产品所有者硬规定）：
 * 卡里给了 `photo` 的镜头**不是**"静态照片段"，而是**素材镜**——真实素材只作**生成输入**，
 * 由 `material-gen` 阶段把它当首帧交给生成模型出带真实运动的镜头（gate G-MAT1）。
 * 因此这类镜头：跳过文生关键帧（首帧就是真实素材），但仍要**有提示词、有提交门、有产物溯源**，
 * 且**严禁**用"裁切 + 推拉/滤镜"把素材本身当镜头（旧的 `photo-motion` 路径已删除）。
 * 相关环节按"生成镜/素材镜"分流，否则 G7 会因为"素材镜没有文生关键帧"而误判缺件。
 */
const isMaterialShot = (shot: ShotCard): boolean => String((shot as Record<string, unknown>).photo ?? "").trim().length > 0;
/**
 * **授权真人素材镜**（T-2026-0929-0003，真机探针 2026-09-29）：
 * 镜头卡给出 `assetRef: "asset://<asset ID>"` 时，主角是**火山方舟「私域真人人像库」里已认证的真人**。
 *   · Seedream 图片接口**不接受** `asset://`（真机 400 `invalid url specified`）→ 跳过文生关键帧；
 *   · Seedance 视频接口**接受** `asset://` 作参考图（真机 200 受理并出片，口型/台词可用）→ 以参考图出片，
 *     **不传首帧**（首帧会给一张 AI 生成的脸，顶掉真人身份）；
 *   · 授权有效性属平台侧事实：本工具只校验引用格式并如实标记
 *     `external-asset-id-not-provider-verified`，不把"格式合法"当"授权有效"。
 */
const ASSET_REF_PATTERN = /^asset:\/\/[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** 注意：**不要**写成 `value is string` 的类型谓词——那会把 `string` 在否定分支收窄成 `never`（TS 实测） */
const isAssetRefLocal = (value: unknown): boolean => typeof value === "string" && ASSET_REF_PATTERN.test(value.trim());
const assetRefOf = (shot: ShotCard): string => String((shot as Record<string, unknown>).assetRef ?? "").trim();
const isAssetShot = (shot: ShotCard): boolean => isAssetRefLocal(assetRefOf(shot));
/** 送审基准图只投本地文件：asset:// 是平台引用、不是文件路径（真机 ENOENT 事故） */
const localReviewRefsEarly = (list: string[]): string[] => list.filter((ref) => !isAssetRefLocal(ref) && existsSync(ref));
const generatedShots = (): ShotCard[] => shots.filter((shot) => !isMaterialShot(shot) && !isAssetShot(shot));
const materialShots = (): ShotCard[] => shots.filter((shot) => isMaterialShot(shot));
/** 商品镜：素材镜里由 G-PROD1 绑定真实商品档案的镜头（参考图锁的是**产品外观**，不要求复刻参考构图） */
const isProductMaterialShot = (shot: ShotCard): boolean => Boolean((shot as Record<string, unknown>).productRef);
/** 需要提示词文生关键帧/台词的人镜两类：生成镜 + 授权真人素材镜（素材镜另有动效提示词） */
const promptShots = (): ShotCard[] => shots.filter((shot) => !isMaterialShot(shot));
const assetShots = (): ShotCard[] => shots.filter((shot) => isAssetShot(shot) && !isMaterialShot(shot));
/** 开跑前 fail-fast：`assetRef` 存在但格式不合法（例如漏了 `asset://` 前缀）要当场停，不能静默降级成生成镜 */
for (const shot of shots.filter(requiresGeneration)) {
  const raw = (shot as Record<string, unknown>).assetRef;
  if (raw !== undefined && String(raw).trim().length > 0 && !isAssetRefLocal(raw)) {
    throw new Error(`授权真人素材引用格式非法（${shot.shotId}）：${String(raw).slice(0, 80)}（应为 asset://<asset ID>）`);
  }
}
if (assetShots().length > 0) {
  log(`授权真人素材镜 ${assetShots().length} 镜：${assetShots().map((s) => `${s.shotId}→${assetRefOf(s)}`).join(" · ")}（外部素材 ID，未向平台核验授权有效性）`);
}

/**
 * 提交前硬闸（T-2026-0929-0013，客户口径："问题要在提交提示词之前发现，不要反复重试烧钱"）：
 * 在**每一次真正花钱的提交之前**，对最终编译出来的提示词做确定性体检；命中红线即拒绝提交（fail-closed），
 * 并把结论写进门账本（G-PRE1）。同时禁止"同一提示词重试"（指纹相同 = 同一注押两次）。
 */
function preflightSubmitGuard(input: { shotId: string; stage: string; prompt: string; fps: number; attempt: number; prevFingerprint: string | null }): void {
  const text = input.prompt;
  const issues: string[] = [];
  const hasScreen = /屏幕|触控|界面/.test(text);
  const screenOk = /(虚化|不可辨|光晕|过曝成色块|背对|不出现)/.test(text);
  if (hasScreen && !screenOk) issues.push("屏幕类元素未声明虚化/背对/不入画——模型会把界面渲染成可读文字（真机返修 6 次）");
  const hasDoc = /身份证|证件|护照|单据|票据/.test(text);
  const docOk = /(不可辨|背面|无证件文字|无身份证|不出现)/.test(text);
  if (hasDoc && !docOk) issues.push("证件类道具未声明不可辨认/背面/不入画——会出现可辨字迹与号码（隐私红线，真机返修 5 次）");
  const submissionShot = shots.find(shot => shot.shotId === input.shotId);
  if (!submissionShot) throw new Error(`SUBMISSION_SHOT_UNKNOWN: ${input.shotId}`);
  const timingConflict = assessFilmFirstPass([submissionShot], { fps: input.fps }).blockers
    .find(entry => entry.finding.id === "timing-lock-vs-motion");
  if (timingConflict) issues.push(`实际同窗口运镜冲突：${timingConflict.finding.detail}（落幅必漂）`);
  const fpsMatch = text.match(/(\d{2})\s*fps/i);
  if (fpsMatch && Number(fpsMatch[1]) !== input.fps) issues.push(`提示词写 ${fpsMatch[1]}fps，管线按 ${input.fps}fps 出片`);
  const fingerprint = createHash("sha256").update(text).digest("hex").slice(0, 12);
  const identicalRetry = input.prevFingerprint !== null && input.prevFingerprint === fingerprint;
  if (identicalRetry) issues.push("本次重试的提示词与上一次完全相同（指纹 " + fingerprint + "）——禁止同注押两次");
  const gate = recordGate({
    stepKey: "g-pre-submit",
    sourceStage: input.stage,
    checks: [
      { id: "no-text-redline", pass: !issues.some((i) => i.includes("可读文字") || i.includes("可辨字迹")), hard: true, detail: issues.filter((i) => i.includes("可读文字") || i.includes("可辨字迹")).join("；") || "无文字类红线" },
      { id: "no-timing-conflict", pass: !issues.some((i) => i.includes("落幅必漂")), hard: true, detail: issues.find((i) => i.includes("落幅必漂")) ?? "无时点/运镜冲突" },
      { id: "no-identical-retry", pass: !identicalRetry, hard: true, detail: identicalRetry ? "同提示词重试被拒" : `提示词指纹 ${fingerprint}（第 ${input.attempt} 次提交）` },
      { id: "fps-consistent", pass: !issues.some((i) => i.includes("fps")), hard: true, detail: issues.find((i) => i.includes("fps")) ?? "帧率一致" }
    ],
    shotIds: [input.shotId],
    evidence: { stage: input.stage, attempt: input.attempt, promptChars: text.length, fingerprint, issues },
    reason: issues.length === 0 ? `提交前体检通过（${input.stage}/${input.shotId}，指纹 ${fingerprint}）` : `提交前体检未通过：${issues.join("；")}`
  });
  if (!gate.approved) {
    throw new Error(`PREFLIGHT_BLOCKED（未花钱）：${input.shotId} — ${issues.join("；")}｜修好提示词再提交，不要靠重试`);
  }
  if (issues.length === 0) log(`  ✓ 提交前体检（G-PRE1）：${input.shotId} 指纹 ${fingerprint}`);
}

/* ---------- ⓪-0.3 一次过就绪度门（G-FP1，T-2026-0929-0009：不再盲重试烧额度） ---------- */
/**
 * 真机归因：本会话每一次返修都能在卡片里提前看到——让模型"别写屏幕字"、6 秒里锁"2.5s 定住"又要推镜、
 * 服装锁到面料配饰、一镜塞三个互相打架的诉求。这里在花钱前给出**就绪度 + 改卡建议**，
 * 并把**最险的镜头排到渲染队列最前面**（canary 先错，只花一镜的钱）。
 */
let FIRST_PASS_ORDER: ShotCard[] = shots;
if (NEEDS_PREPRODUCTION) {
  const readiness = assessFilmFirstPass(shots.filter(requiresGeneration) as unknown as Array<Record<string, unknown>>, { fps: FPS });
  const shotIds = shots.map((shot) => String(shot.shotId));
  const order = readiness.renderOrder;
  FIRST_PASS_ORDER = [...shots.filter(shot => !requiresGeneration(shot)), ...order.map((id) => shots.find((shot) => String(shot.shotId) === id)!).filter(Boolean)];
  const gate = recordGate({
    stepKey: "g-first-pass",
    sourceStage: "prompt",
    checks: [
      {
        id: "first-pass-ready", pass: readiness.ready, hard: true,
        detail: readiness.ready
          ? `${FIRST_PASS_POLICY_VERSION}：${shots.length} 镜无高风险项（就绪度通过；渲染顺序按风险降序：${order.join(" → ")}）`
          : readiness.blockers.map((entry) => `${entry.shotId}｜${entry.finding.id}｜${entry.finding.detail}｜改卡建议：${entry.finding.suggestion}`).join("；")
      }
    ],
    shotIds,
    evidence: { policy: FIRST_PASS_POLICY_VERSION, perShot: readiness.perShot, renderOrder: order },
    reason: readiness.ready ? `${FIRST_PASS_POLICY_VERSION}：就绪` : `存在 ${readiness.blockers.length} 项高风险（花钱前拦住）`
  });
  if (!gate.approved) {
    log(`⛔ 一次过就绪度未通过（未花任何渲染额度）：`);
    for (const entry of readiness.blockers) log(`   · ${entry.shotId} ${entry.finding.id}：${entry.finding.detail}\n     改卡建议：${entry.finding.suggestion}`);
    throw new Error(`FIRST_PASS_NOT_READY: ${readiness.blockers.map((entry) => `${entry.shotId}:${entry.finding.id}`).join(",")}`);
  }
  log(`一次过就绪度 G-FP1 通过（渲染顺序按风险降序：${order.join(" → ")}）`);
}


/* ---------- ⓪-0.4 提示词红线门（G-RL1，T-2026-0929-0008：提高一次过率） ---------- */
/**
 * 每一次"渲完才发现"的返修，都对应一条可以提前写死在卡片里的红线。这里在**花钱之前**统一清零：
 * 屏幕文字/图标/LOGO、证件字迹与号码、卡片类道具重复、timeline 定住而运镜没定住、卡片与管线帧率不一致。
 * hard 项不清零就 fail-closed；soft 项进证据与日志（不阻断，但必须被看见）。
 */
if (NEEDS_PREPRODUCTION) {
  const redlines = auditFilmRedlines(shots.filter(requiresGeneration) as unknown as Array<Record<string, unknown>>, { fps: FPS });
  const shotIds = shots.map((shot) => String(shot.shotId));
  const redlineGate = recordGate({
    stepKey: "g-prompt-redlines",
    sourceStage: "prompt",
    checks: [
      {
        id: "redlines-clear", pass: redlines.hard.length === 0, hard: true,
        detail: redlines.hard.length === 0
          ? `${PROMPT_REDLINE_POLICY_VERSION}：${shots.length} 镜红线清零（soft ${redlines.soft.length} 项已记录）`
          : redlines.hard.map((issue) => `${issue.id}｜${issue.detail}｜为什么：${issue.why}`).join("；")
      },
      ...(redlines.soft.length > 0
        ? [{ id: "redlines-soft", pass: true, hard: false, detail: redlines.soft.map((issue) => `${issue.id}｜${issue.detail}`).join("；") }]
        : [])
    ],
    shotIds,
    evidence: { policy: PROMPT_REDLINE_POLICY_VERSION, perShot: redlines.perShot, soft: redlines.soft },
    reason: redlines.hard.length === 0
      ? `提示词红线 ${PROMPT_REDLINE_POLICY_VERSION}：hard 0 · soft ${redlines.soft.length}`
      : `提示词红线未清零（${redlines.hard.length} 项 hard）`
  });
  if (!redlineGate.approved) {
    throw new Error(`提示词红线未清零（花钱前拦住）：${redlines.hard.map((issue) => `[${issue.id}] ${issue.detail}`).join("；")}`);
  }
  for (const issue of redlines.soft.slice(0, 6)) log(`⚠ 提示词红线（软）${issue.id}：${issue.detail}`);
}

/* ---------- ⓪-0.5 认证真人素材一致性门（T-2026-0929-0007，事故机制化） ---------- */
/**
 * 事故复盘（2026-09-29）：客户给了平台已认证的真人素材 ID，但系统只校验"引用能不能提交"，
 * 没有任何地方记录"这位真人是谁"；镜头卡文案写男性 → 模型跟文案 → 6 镜渲成男性全部被拒收。
 * 本门把人物属性变成硬闸：
 *   ① 每个 `asset://` 必须有**真人主档**（bundles/ai-video/library/real-person-assets/<assetId>/profile.json）；
 *   ② 主档必须 real-authorized 且在有效期内，性别等关键属性不许为空（缺了先问客户，禁止先生成）；
 *   ③ 镜头卡文本与主档属性**逐项一致**（性别/年龄段/assetRef），冲突即 fail-closed；
 *   ④ 本门只约束尚未生成的提交；供应商成功源片按任务/当前字节直接正式后期，不做 canary 身份二检。
 */

const realPersonChecks: GateCheck[] = [];

const realPersonByShot = new Map<string, { assetId: string; displayName: string; scopeText: string }>();
for (const shot of assetShots().filter(requiresGeneration)) {
  const id = assetIdOf(assetRefOf(shot));
  const entry = realPersonLibrary.byAssetId.get(id);
  if (!entry) {
    throw new Error(`镜头 ${shot.shotId} 使用认证真人素材 ${id}，但真人主档库里没有该素材（${REAL_PERSON_LIBRARY}）→ 先建主档（性别/年龄段/授权/证据），禁止临时编人物属性`);
  }
  const hard = entry.issues.filter((issue) => issue.hard);
  if (hard.length > 0) {
    throw new Error(`认证真人主档 ${id} 不可用：${hard.map((issue) => `[${issue.code}] ${issue.detail}`).join("；")}`
      + `（缺关键属性时**先向客户确认**，不允许先拍后猜）`);
  }
  const conflicts = assertShotMatchesCertifiedAsset(shot as unknown as Record<string, unknown>, entry.asset);
  const hardConflicts = conflicts.filter((issue) => issue.hard);
  if (hardConflicts.length > 0) {
    throw new Error(`认证真人一致性门未通过（${REAL_PERSON_POLICY_VERSION}）：${hardConflicts.map((issue) => `[${issue.code}] ${issue.detail}`).join("；")}`);
  }
  realPersonChecks.push({
    id: `certified-consistent:${shot.shotId}`, pass: true, hard: true,
    detail: `${shot.shotId} 与主档一致（${entry.asset.displayName}｜${entry.asset.certified.gender}｜${entry.asset.certified.ageBand ?? "年龄段未声明"}）`
  });
  realPersonByShot.set(String(shot.shotId), { assetId: id, displayName: entry.asset.displayName, scopeText: identityReviewContext(entry.asset).discipline as string });

}
if (realPersonChecks.length > 0) {
  const realPersonGate = recordGate({
    stepKey: "g-real-person",
    sourceStage: "portrait",
    checks: realPersonChecks,
    shotIds: [...realPersonByShot.keys()],
    evidence: {
      library: REAL_PERSON_LIBRARY,
      policy: REAL_PERSON_POLICY_VERSION,
      usage: assetShots().filter(requiresGeneration).map((shot) => realPersonUsageReceipt({ asset: realPersonLibrary.byAssetId.get(assetIdOf(assetRefOf(shot)))!.asset, projectId: PROJECT, shots: [String(shot.shotId)] }))
    },
    reason: `认证真人一致性门通过：${realPersonChecks.length} 镜与平台认证主档属性一致（资产 ID 与授权证据已留痕）`
  });
  if (!realPersonGate.approved) throw new Error(`认证真人门未通过：${realPersonGate.reason}`);
  log(`认证真人素材门 G-RP1 通过：${realPersonChecks.length} 镜（主档 ${REAL_PERSON_LIBRARY}）`);
}

/* ---------- ⓪-0 真实商品档案绑定（T-2026-0929-0004） ---------- */
/**
 * 产品口径（产品所有者 2026-09-29）：涉及**具体公司名或品牌名**的片子，默认必须用该公司/品牌的**真实产品**。
 *   · 系统里有档案（`bundles/ai-video/library/products/*`）就用它：客户上传的档案优先于系统检索生成的档案；
 *   · 没有档案 → **fail-closed**：先跑 `scripts/tools/product-archive.mts search|build` 建档，不拿 AI 编产品；
 *   · 绑定后该镜自动成为**素材镜**（真实产品照片只作生成输入，materialUsage=generation-reference），
 *     并把"外观以参考照片为准、不得改结构/标识"写进道具口径——由 material-gen 阶段按 G-MAT1 把关。
 */
const PRODUCT_LIBRARY = resolve(arg("--product-library", join(REPO_ROOT, "bundles/ai-video/library/products")));
const productLibrary: ReturnType<typeof loadProductArchives> = NEEDS_PREPRODUCTION ? loadProductArchives(PRODUCT_LIBRARY, {
  probeImage: (file: string) => {
    try {
      const info = probe(file);
      const width = Number(info.width ?? 0);
      const height = Number(info.height ?? 0);
      return width > 0 && height > 0 ? { width, height } : null;
    } catch { return null; }
  }
}) : { root: PRODUCT_LIBRARY, archives: [], byId: new Map(), issues: [] };
const productSelectorOf = (shot: ShotCard): string => String((shot as Record<string, unknown>).product ?? "").trim();
const declaredProducts = Array.isArray((shotlist as Record<string, unknown>).products) ? ((shotlist as Record<string, unknown>).products as unknown[]).map((item) => String(item).trim()).filter(Boolean) : [];
const declaredCompany = String((shotlist as Record<string, unknown>).company ?? "").trim();
const declaredBrand = String((shotlist as Record<string, unknown>).brand ?? "").trim();
const productBindingGuide = `请先建档：tsx scripts/tools/product-archive.mts search --name "<公司/品牌>"（系统检索，priority=1）`
  + `，或由客户提供照片后 tsx scripts/tools/product-archive.mts build --name "<商品名>" --photo <图…> --company "<公司>"（priority=10）`;
/**
 * 档案库整体只做**告警**：一个多商品方案库里难免有"只有参数、没有产品图"的成员（例如同页多型号）。
 * 真正 fail-closed 的时机是**本片引用它**的时候（下面解析不到可用档案即报错），而不是别人家的档案不完整就拦住本片。
 */
const brokenArchives = productLibrary.archives.filter((entry) => entry.issues.some((issue) => issue.hard));
if (brokenArchives.length > 0) {
  log(`⚠ 商品档案库有 ${brokenArchives.length} 份档案存在硬问题（本片未引用则不拦截）：`
    + brokenArchives.map((entry) => `${entry.archive.id}[${entry.issues.filter((issue) => issue.hard).map((issue) => issue.code).join(",")}]`).join("、"));
}
if (NEEDS_PREPRODUCTION && (declaredCompany || declaredBrand)) {
  const ownerSelector = declaredCompany || declaredBrand;
  const ownerMatch = selectProductArchive(productLibrary.archives, ownerSelector);
  if (!ownerMatch.archive) {
    throw new Error(`本片声明了公司/品牌「${ownerSelector}」，但商品档案库里没有对应档案（${ownerMatch.reason}）。`
      + `涉及具体公司/品牌的片子必须使用真实产品：${productBindingGuide}`);
  }
}
const productBindings: Array<{ shotId: string; selector: string; archiveId: string; sourceKind: string; priority: number; matchedBy: string; photoFile: string; photoSha256: string; bound: boolean }> = [];
for (const selector of NEEDS_PREPRODUCTION ? declaredProducts : []) {
  if (!selectProductArchive(productLibrary.archives, selector).archive) {
    throw new Error(`shotlist.products 声明的商品「${selector}」没有可用档案：${productBindingGuide}`);
  }
}
for (const shot of shots.filter(requiresGeneration)) {
  const selector = productSelectorOf(shot);
  if (!selector) continue;
  const match = selectProductArchive(productLibrary.archives, selector);
  if (!match.archive || !match.dir) {
    throw new Error(`镜头 ${shot.shotId} 声明了商品「${selector}」，但没有可用的真实商品档案（${match.reason}）。${productBindingGuide}`);
  }
  const entry = productLibrary.byId.get(match.archive.id)!;
  const hero = productHeroPhoto(match.archive);
  if (!hero) throw new Error(`镜头 ${shot.shotId} 绑定的商品档案 ${match.archive.id} 没有主图（role=hero）`);
  const card = shot as Record<string, unknown>;
  const existingPhoto = String(card.photo ?? "").trim();
  const photoAbs = productPhotoPath(entry, hero);
  const bound = !existingPhoto;
  if (bound) {
    card.photo = photoAbs;
    card.materialUsage = "generation-reference";
    card.focus = { x: 0.5, y: 0.5 };
  }
  card.productRef = {
    id: match.archive.id,
    sourceKind: match.archive.source.kind,
    priority: match.archive.source.priority,
    matchedBy: match.matchedBy,
    photo: hero.file,
    photoSha256: hero.sha256,
    reviewStatus: match.archive.source.reviewStatus ?? null,
    bound
  };
  card.props = [String(card.props ?? "").trim(), productArchivePromptLines(match.archive).join("｜")].filter(Boolean).join("｜");
  productBindings.push({
    shotId: String(shot.shotId), selector, archiveId: match.archive.id, sourceKind: match.archive.source.kind,
    priority: match.archive.source.priority, matchedBy: String(match.matchedBy), photoFile: photoAbs, photoSha256: hero.sha256, bound
  });
  log(`真实商品绑定 ${shot.shotId} ← ${match.archive.id}（${match.archive.source.kind}，priority=${match.archive.source.priority}）主图 ${hero.file}`);
}
if (productBindings.length > 0) {
  const systemGenerated = productBindings.filter((entry) => entry.sourceKind === "system-generated");
  const productGate = recordGate({
    stepKey: "g-product-ref",
    sourceStage: "product",
    checks: [
      { id: "product-archive-present", pass: productBindings.length > 0, hard: true, detail: `${productBindings.length} 镜绑定真实商品档案（库 ${PRODUCT_LIBRARY}）` },
      { id: "product-photo-verified", pass: productBindings.every((entry) => existsSync(entry.photoFile)), hard: true, detail: productBindings.map((entry) => `${entry.shotId}→${basename(entry.photoFile)}`).join("、") },
      {
        id: "product-source-priority", pass: true, hard: true,
        detail: systemGenerated.length > 0
          ? `${systemGenerated.length} 镜用的是**系统检索生成**的商品档案（priority=1，带检索证据与免责声明，未经客户确认）；客户上传档案（priority=10）可随时替换`
          : `全部使用客户上传的商品档案（priority=10）`
      },
      { id: "product-binding", pass: productBindings.every((entry) => entry.bound), hard: false, detail: productBindings.map((entry) => `${entry.shotId}:${entry.bound ? "已自动绑定主图" : "沿用镜头卡自带素材"}`).join("、") }
    ],
    shotIds: productBindings.map((entry) => entry.shotId),
    evidence: { library: PRODUCT_LIBRARY, bindings: productBindings, declaredProducts, company: declaredCompany || null, brand: declaredBrand || null },
    reason: `真实商品档案绑定 ${productBindings.length} 镜（客户上传优先，系统检索次之）`
  });
  if (!productGate.approved) throw new Error(`真实商品档案门未通过：${productGate.reason}`);
} else if (declaredCompany || declaredBrand || declaredProducts.length > 0) {
  log(`ℹ️ 本片声明了公司/品牌（${declaredCompany || declaredBrand}）但没有任何镜头绑定商品（shot.product 未声明）：未做真实商品绑定`);
}
/**
 * 素材用途**在开跑前先验一遍**（fail-fast）：缺声明/写成静态直出用途时当场停，
 * 不等到出片阶段才发现"这一镜本来就不该这么做"。错误信息里带规则原文。
 */
for (const shot of materialShots().filter(requiresGeneration)) {
  try {
    readMaterialSpec(shot as unknown as Record<string, unknown>);
  } catch (err) {
    throw new Error(`素材用途硬约束未通过（${MATERIAL_POLICY_VERSION}）：${err instanceof Error ? err.message : String(err)}`);
  }
  log(`素材镜 ${shot.shotId}：素材用途声明 ok（generation-reference）——素材只作生成输入，禁止静态直出`);
}

interface CharacterEntryLike {
  id: string; name: string; files: Record<string, string>; dir: string;
  version: number | null;
  /** 档案正文里的外貌描述（纯文生图时的唯一人物变量；真人图不可作为视频首帧时靠它保人） */
  appearanceText: string;
}
/**
 * 角色库装载（2026-09-24 扩展）：除 `HR_CHARACTER_LIBRARY` 外，**同时**装载随仓分发的默认模特库
 * `bundles/ai-video/library/characters/*`（系统默认 1 号模特 = 陈卓），并读取 registry.json 的别名表——
 * 这样"未指定模特时自动用陈卓""镜头卡写'陈卓'时解析到该档案"两条规则才能在管线里生效。
 */
function loadCharacters(): Map<string, CharacterEntryLike> {
  const library = new Map<string, CharacterEntryLike>();
  const repoCharacters = join(REPO_ROOT, "bundles/ai-video/library/characters");
  for (const root of [LIBRARY, repoCharacters]) {
    if (existsSync(root)) loadCharacterRoot(root, library);
  }
  return library;
}

/** registry.json：默认模特 + 姓名别名（别名解析在选角时用） */
function loadCharacterRegistry(): { defaultModel: string | null; aliases: Array<{ id: string; names: string[] }> } {
  const file = join(REPO_ROOT, "bundles/ai-video/library/characters/registry.json");
  if (!existsSync(file)) return { defaultModel: null, aliases: [] };
  try {
    const doc = JSON.parse(readFileSync(file, "utf8")) as {
      defaultModel?: string;
      models?: Array<{ id: string; name?: string; aliases?: string[] }>;
    };
    return {
      defaultModel: doc.defaultModel ?? null,
      aliases: (doc.models ?? []).map((m) => ({ id: m.id, names: [m.id, m.name ?? "", ...(m.aliases ?? [])].filter(Boolean) }))
    };
  } catch {
    return { defaultModel: null, aliases: [] };
  }
}

function loadCharacterRoot(root: string, library: Map<string, CharacterEntryLike>): void {
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    const profileFile = join(dir, "profile.json");
    if (!existsSync(profileFile) || !statSync(dir).isDirectory()) continue;
    const profile = JSON.parse(readFileSync(profileFile, "utf8")) as {
      id: string; name: string;
      identity?: Record<string, unknown>;
      appearance?: Record<string, unknown>;
      wardrobe?: Array<Record<string, unknown>>;
      portraitSets?: Array<{ dir: string; angles: string[]; active?: boolean; version: number; assets?: Record<string, string> }>;
    };
    const sets = profile.portraitSets ?? [];
    const active = sets.find((s) => s.active) ?? sets[sets.length - 1];
    const files: Record<string, string> = {};
    /**
     * 授权真人素材（T-2026-0929-0003）：档案里可以只给平台素材引用（`assets` 映射），
     * 没有本地定妆照文件。此时角度 → `asset://<asset ID>`，由 Seedance 作参考图承担人物身份；
     * 与本地文件角度可混用（本地文件优先）。
     */
    for (const [angle, ref] of Object.entries(active?.assets ?? {})) {
      if (isAssetRefLocal(ref)) files[angle] = ref.trim();
    }
    if (active) {
      const setDir = join(dir, active.dir);
      if (existsSync(setDir)) {
        for (const angle of active.angles) {
          /**
           * 角度文件解析统一走 `findAngleFile`（2026-09-24 修复）：
           * 早先这里按 `${profile.name}-${angle}` 前缀硬匹配，而随仓 1 号模特的
           * `portraits/v3/` 文件名前缀是"平江路讲述人"、档案 name 是"陈卓" →
           * 8 张定妆照全部匹配不到（G5 门当场亮红才发现）。
           */
          const hit = findAngleFile(setDir, profile.name, angle);
          if (hit) files[angle] = hit;
        }
      }
    }
    /** 档案 → 一段可用于纯文生图的人物描述（与 portrait-agent 的 appearanceOf 同口径，但不含任何地点/道具/时段） */
    const a = profile.appearance ?? {};
    const i = profile.identity ?? {};
    const wardrobe = Array.isArray(profile.wardrobe) && profile.wardrobe.length > 0 ? profile.wardrobe[0]! : {};
    const appearanceText = [
      `一位${String(i.age ?? "").trim()}${String(a.gender ?? i.gender ?? "女性") === "female" ? "女性" : String(a.gender ?? i.gender ?? "女性")}`,
      a.face ? String(a.face) : "",
      a.skin ? `肤质：${String(a.skin)}` : "",
      a.eyes ? `眼睛：${String(a.eyes)}` : "",
      a.hair ? `${String(a.hair)}发型` : "",
      Array.isArray(a.features) && a.features.length > 0 ? `特征：${(a.features as unknown[]).join("；")}` : "",
      a.bodyType ? `身形：${String(a.bodyType)}` : "",
      wardrobe.name ? `穿着${String(wardrobe.name)}${wardrobe.detail ? `（${String(wardrobe.detail)}）` : ""}` : ""
    ].filter(Boolean).join("，");
    library.set(profile.id, { id: profile.id, name: profile.name, files, dir, appearanceText, version: active?.version ?? null });
  }
}
const characters = NEEDS_PREPRODUCTION ? loadCharacters() : new Map<string, CharacterEntryLike>();
/**
 * 选角（2026-09-24 规则）：
 *   ① 镜头卡/项目显式指定 → 用指定的；
 *   ② 文本里出现模特姓名或别名（如"陈卓"）→ 解析到该档案；
 *   ③ 都没指定 → 回落到 registry.json 的 **defaultModel（系统默认 1 号模特 = 陈卓）**；
 *   ④ 仍然没有 → 用库里第一个（并如实记录，不静默）。
 */
const characterRegistry = NEEDS_PREPRODUCTION ? loadCharacterRegistry() : { defaultModel: null, aliases: [] };
const lead = (() => {
  const list = [...characters.values()];
  const explicitId = shotlist.character?.id ?? "";
  const explicitName = shotlist.character?.name ?? "";
  const byExplicit = list.find((c) => c.id === explicitId || c.name === explicitName);
  if (byExplicit) return byExplicit;
  const aliasHit = characterRegistry.aliases.find((a) => a.names.some((n) => n && n.length > 1 && explicitName.includes(n)));
  if (aliasHit) return list.find((c) => c.id === aliasHit.id) ?? undefined;
  if (characterRegistry.defaultModel) {
    const preferred = list.find((c) => c.id === characterRegistry.defaultModel);
    if (preferred) return preferred;
  }
  return list[0];
})();
if (lead && characterRegistry.defaultModel && lead.id === characterRegistry.defaultModel) {
  log(`未显式指定模特 → 使用系统默认模特：${lead.name}（${lead.id}，1 号）`);
}

/* ---------- ⓪-0 G5 定妆照确认（step_key: g5-portrait-confirm） ---------- */
/**
 * 管线 yml 的 `g5-portrait-confirm` 门：确认"这组定妆照可用于本片"。
 *
 * CLI 口径 = **资产硬闸 + 人类验收记录**（T-2026-1001-0007）：
 *   · 硬闸：角色档案在、四个必需角度齐备、单张 >50KB（占位图/失败图直接拦）；
 *   · 人类验收：读角色目录 `gates.jsonl` 最近一条 `g5-portrait-confirm`（`portrait-agent accept` 产出，
 *     `via=owner-acceptance`）；只有人类记录能做放行/否决，人类否决即阻断；
 *   · 机器评审（`portrait-agent review` 的 reviews/*.json / gates.jsonl 的 llm 记录）**只留证、不参与放行**，
 *     既不会因"机器判不合格"卡住交付，也不冒充人类签字；
 *   · 两条记录都没有时照常做资产闸但标 degraded（不冒充已验收），需先执行 `accept`。
 * 与 §⑤ 的 `keyframe`/`shot` 门不同，G5 管的是**角色资产**，不是本片画面。
 */
if (!DRY_RUN && NEEDS_PREPRODUCTION) {
  const requiredAngles = ["front", "threeQuarter", "closeup", "side"];
  const published = lead ? requiredAngles.map((angle) => ({ angle, path: lead.files[angle] ?? "" })) : [];
  /**
   * 授权真人素材引用（`asset://<asset ID>`）**不是本地文件**：没有文件、没有字节数可量。
   * 判据改为"引用格式合法即算在场"，并在 checks 里单列一条如实说明
   * `external-asset-id-not-provider-verified`（本工具不向平台核验授权有效性）。
   */
  const missing = published.filter((f) => !f.path || (!isAssetRefLocal(f.path) && !existsSync(f.path)));
  /** 安全取字节数：缺失/空路径返回 0（真机 2026-09-24：空路径直接 statSync 抛 ENOENT 把整个运行打断） */
  const sizeOf = (path: string): number => (path && existsSync(path) ? statSync(path).size : 0);
  const tiny = published.filter((f) => !isAssetRefLocal(f.path) && sizeOf(f.path) > 0 && sizeOf(f.path) < 50_000);
  const externalRefs = published.filter((f) => isAssetRefLocal(f.path)).map((f) => `${f.angle}=${f.path}`);
  /**
   * 定妆照监制记录：**优先读角色目录的门账本 `gates.jsonl`**（`g5-portrait-confirm`，
   * 由 `portrait-agent review` 落账，2026-09-24 起）；没有门记录时回退到 `reviews/*.json`。
   * 这样"定妆照确认"就有了按 step_key 的机器可读记录，而不是靠人翻评审文件。
   */
  const gateRecord = (() => {
    if (!lead) return null;
    const ledger = join(lead.dir, "gates.jsonl");
    if (!existsSync(ledger)) return null;
    try {
      const events = readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as {
        stepKey?: string; projectId?: string; at?: string; approved?: boolean; score?: number | null; reason?: string;
        via?: string | null; sourceStage?: string | null; evidence?: { basis?: string | null; ownerAcceptance?: string } | null;
      });
      return selectPortraitDecisionRecord(events, `portrait:${lead.id}:v${lead.version}`);
    } catch (error) { throw new Error(`角色门账本不可读取：${error instanceof Error ? error.message : String(error)}`); }
  })();
  const reviewFile = (() => {
    if (!lead) return null;
    const dir = join(lead.dir, "reviews");
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    return files.length > 0 ? join(dir, files[files.length - 1]!) : null;
  })();
  const review = (() => {
    if (!reviewFile) return null;
    try {
      return JSON.parse(readFileSync(reviewFile, "utf8")) as { at?: string; verdict?: { approved?: boolean; score?: number; reason?: string } };
    } catch { return null; }
  })();
  /**
   * 决策语义（T-2026-1001-0007）：只有人类验收记录可放行/否决；机器记录（含旧版被机器判据带成
   * approved=false 的记录）一律按留证处理。口径单测见 `packages/video-studio/src/portrait-decision.test.ts`。
   */
  const portraitDecision = assessPortraitDecision(
    gateRecord ?? (review
      ? {
          at: review.at ?? null, approved: review.verdict?.approved, score: review.verdict?.score ?? null,
          reason: review.verdict?.reason ?? null, via: "llm", sourceStage: "portrait-review",
        }
      : null),
  );
  let acceptanceBytesVerified = false;
  if (lead && portraitDecision.decisive && !portraitDecision.blocking) {
    const receiptFile = gateRecord?.evidence?.ownerAcceptance;
    if (receiptFile) {
      try {
        const localReceipt = join(lead.dir, "reviews", basename(receiptFile));
        const receipt = JSON.parse(readFileSync(localReceipt, "utf8")) as { characterId?: string; version?: number; artifacts?: Array<{ angle?: string; file: string; sha256: string }> };
        acceptanceBytesVerified = receipt.characterId === lead.id && receipt.version === lead.version
          && published.every(({ angle, path }) => !isAssetRefLocal(path) && existsSync(path)
            && receipt.artifacts?.some((item) => (item.angle === angle || resolve(item.file) === resolve(path)) && item.sha256 === sha256FileSync(path)));
      } catch (error) { log(`人类验收文件核验失败：${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  const checks: GateCheck[] = lead
    ? [
        { id: "character-present", pass: true, detail: `角色 ${lead.name}（${lead.id}）`, hard: true },
        {
          id: "required-angles", pass: missing.length === 0, hard: true,
          detail: missing.length === 0
            ? `必需角度齐备：${requiredAngles.join("/")}`
            : `缺角度或文件不存在：${missing.map((m) => m.angle).join("/")}`
        },
        {
          id: "file-size", pass: tiny.length === 0, hard: true,
          detail: tiny.length === 0
            ? `四角度均 >50KB 或为授权素材引用（${published.map((f) => `${f.angle}=${isAssetRefLocal(f.path) ? "asset://" : `${(sizeOf(f.path) / 1024).toFixed(0)}KB`}`).join(" ")}）`
            : `以下角度文件过小（疑似占位图）：${tiny.map((f) => f.angle).join("/")}`
        },
        ...(externalRefs.length > 0
          ? [{
              id: "external-asset-ref", pass: true, hard: true,
              detail: `授权真人素材引用 ${externalRefs.length} 个角度（${externalRefs.join("、")}）——`
                + "外部素材 ID：本工具只校验引用格式，未向平台核验授权有效期与归属（external-asset-id-not-provider-verified）"
            }]
          : []),
        {
          /** 附加信息（不参与硬闸）：档案里一共有多少角度可用——只有 4 个必需角度时也能拍，但选择面更窄 */
          id: "archive-angles", pass: Object.keys(lead.files).length >= 4, hard: false,
          detail: `档案可用角度 ${Object.keys(lead.files).join("/") || "无"}（共 ${Object.keys(lead.files).length} 个）`
        },
        ...(portraitDecision.kind === "none"
          ? []
          : [{
              id: "portrait-decision",
              /** 人类否决才阻断；机器记录只留证（hard=false，pass 恒为 true） */
              pass: !portraitDecision.blocking,
              hard: portraitDecision.decisive,
              detail: `${portraitDecision.detail}（来源：${gateRecord ? "gates.jsonl" : "reviews/*.json"}）`
            }]),
        ...(portraitDecision.decisive && !portraitDecision.blocking ? [{
          id: "human-acceptance-bytes", pass: acceptanceBytesVerified, hard: true,
          detail: acceptanceBytesVerified ? "当前角色版本的四角度字节与人类验收指纹一致" : "当前定妆照未与人类验收指纹绑定或已变化，须重新验收"
        }] : [])
      ]
    : [{ id: "applicable", pass: true, detail: "镜头卡未涉及人物（空镜片）→ 定妆照门不适用", hard: false }];
  const gate = recordGate({
    stepKey: "g5-portrait-confirm",
    sourceStage: "portrait",
    checks,
    /**
     * 没有定妆照监制记录时**不冒充实质评审**：确定性闸照跑，但 degraded 置位，
     * 让审计一眼看到"这个门这次只做了资产校验"。
     *
     * 例外（T-2026-0929-0003）：**全角度为平台授权真人素材引用**（asset://）时，
     * 人物同一性由平台在「私域真人人像库」建档时做了一致性校验与授权，本地没有图片可评——
     * 此时"external-asset-ref"判据就是这道门的实质判据，不再因"没有本地监制记录"降级；
     * 授权有效期与归属仍如实标注为未由本工具核验（external-asset-id-not-provider-verified）。
     */
    degraded: Boolean(lead) && portraitDecision.kind === "none" && externalRefs.length === 0,
    evidence: {
      character: lead ? { id: lead.id, name: lead.name, angles: Object.keys(lead.files) } : null,
      reviewFile,
      gateLedger: lead ? join(lead.dir, "gates.jsonl") : null,
      gateApproved: gateRecord?.approved ?? null,
      reviewApproved: review?.verdict?.approved ?? null,
      portraitDecision: { kind: portraitDecision.kind, decisive: portraitDecision.decisive, blocking: portraitDecision.blocking, detail: portraitDecision.detail },
      note: portraitDecision.kind === "human"
        ? "含人类验收记录（gates.jsonl，via=owner-acceptance）：放行/否决由人类决定"
        : portraitDecision.kind === "machine"
          ? "含机器评审留证（不参与放行）：机器判据不触发重做，决策交人类"
          : "无人类验收记录：本次仅做资产硬闸（角度/尺寸/字节）"
    },
    reason: lead
      ? (portraitDecision.kind === "none" ? "定妆照资产齐备（无人类验收记录，已标 degraded；请先由人类执行 portrait-agent accept）" : undefined)
      : "本片无人物，定妆照门不适用"
  });
  if (!gate.approved && !ACCEPT_REJECTED.includes("G5")) {
    throw new Error(`G5 定妆照确认未通过：${gate.reason}（确需继续请显式传 --accept-rejected G5）`);
  }
}

/* ================= 关键帧 / 视频 出图出片 ================= */

function dataUrl(file: string): string {
  /** 方舟授权真人素材（`asset://<asset ID>`）不是本地文件：**原样透传**给平台，不能 base64 编码 */
  if (isAssetRefLocal(file)) return file;
  if (WORKER_RUNTIME) return `film-ref:${WORKER_RUNTIME.reference(file)}`;
  const ext = file.toLowerCase().endsWith(".png") ? "png" : file.toLowerCase().endsWith(".webp") ? "webp" : "jpeg";
  return `data:image/${ext};base64,${readFileSync(file).toString("base64")}`;
}

async function arkImage(prompt: string, anchors: string[], size: string, shotId: string, target: string): Promise<string> {
  if (WORKER_RUNTIME) return WORKER_RUNTIME.image(prompt, anchors, size, shotId, target);
  if (!ARK_KEY) throw new Error("PROVIDER_UNCONFIGURED: 实际图片生成需要方舟密钥");
  const payload: Record<string, unknown> = {
    model: IMAGE_MODEL, prompt, size, response_format: "url", watermark: false,
    ...(anchors.length > 0 ? { image: anchors.length === 1 ? dataUrl(anchors[0]!) : anchors.slice(0, 4).map(dataUrl) } : {})
  };
  const endpoint = `${ARK_BASE}/images/generations`;
  const result = await resumeOrSubmitImageTask({ root: GENERATION_ROOTS.imageRoot, projectId: PROJECT,
    slotId: `plate:${shotId}`, provider: "ark", endpoint, body: payload,
    requireExisting: hasPriorFilmGeneration({ projectId: PROJECT, shotId, kind: "image",
      workDirs: GENERATION_ROOTS.evidenceWorkDirs, targets: [target, hostedUrlFile(shotId), plateMetaFile(shotId)] }),
    submit: async body => {
      const res = await fetch(endpoint, { method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ARK_KEY}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(300_000) });
      const text = await res.text();
      if (!res.ok) throw new Error(`出图失败 HTTP ${res.status}：${text.slice(0, 300)}`);
      const json = JSON.parse(text) as { data?: Array<{ url?: string }> };
      const url = json.data?.[0]?.url;
      if (!url) throw new Error(`出图响应缺少 url：${text.slice(0, 200)}`);
      return { url };
    },
  });
  return result.url;
}

/**
 * 关键帧的"托管 URL 台账"（2026-09-24 真机结论）。
 *
 * Ark 视频接口对**真人题材的图片输入**做隐私校验：
 *   · base64 data URL（first_frame / reference_image 都一样）→ 400 `InputImageSensitiveContentDetected.PrivacyInformation`
 *   · **同账号模型产物、以 Ark 托管 URL 形式引用** → 200 受理（探针脚本 `work/film/probe-first-frame.mts` 实测 A/B/C/D 四态）
 * 所以关键帧出图后必须把 Seedream 返回的托管 URL 存下来，供视频环节当首帧用（URL 有有效期，按时间戳老化）。
 */
function hostedUrlFile(shotId: string): string {
  return join(PLATE_DIR, `${shotId}.hosted-url.json`);
}
function saveHostedUrl(shotId: string, url: string): void {
  writeFileSync(hostedUrlFile(shotId), `${JSON.stringify({ url, at: stamp() }, null, 2)}\n`, "utf8");
}
function loadHostedUrl(shotId: string, maxAgeHours = 20): string | null {
  const file = hostedUrlFile(shotId);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { url?: string; at?: string };
    if (!parsed.url || !parsed.at) return null;
    const ageHours = (Date.now() - Date.parse(parsed.at)) / 3_600_000;
    return ageHours <= maxAgeHours ? parsed.url : null;
  } catch {
    return null;
  }
}

/**
 * 关键帧指纹元文件（2026-09-26 新增，T-2026-0926-0007）。
 *
 * 为什么必须落盘：关键帧的缓存命中判据原来是"文件在盘 + >50KB"，改过镜头卡之后旧图会被
 * 当成有效产物复用（真机：把出镜服装从西装改回档案 w1 旗袍后，四镜旧图仍被记 ok）。
 * 现在出图时写一份指纹（出图用的提示词 sha256 + 锚点模式 + 模型），复用前逐条比对。
 */
function plateMetaFile(shotId: string): string {
  return join(PLATE_DIR, `${shotId}.plate-meta.json`);
}

function readPlateMeta(shotId: string): import("../../packages/video-studio/src/plate-cache.js").PlateCacheMeta | null {
  const file = plateMetaFile(shotId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as import("../../packages/video-studio/src/plate-cache.js").PlateCacheMeta;
  } catch {
    return null;
  }
}

function writePlateMeta(shotId: string, promptText: string, anchorMode: string, basePrompt: string, requestSha256: string, artifactFile: string): void {
  const payload = {
    promptSha256: createHash("sha256").update(basePrompt).digest("hex"),
    submittedPromptSha256: createHash("sha256").update(promptText).digest("hex"),
    requestSha256,
    artifactSha256: createHash("sha256").update(readFileSync(artifactFile)).digest("hex"),
    anchorMode,
    model: IMAGE_MODEL,
    at: stamp()
  };
  writeFileSync(plateMetaFile(shotId), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/** 本镜最近一次关键帧裁决是否为放行（被驳回过的产物不得被缓存复用洗白） */
function lastKeyframeApproved(history: StageRecord[], shotId: string): boolean {
  const rows = [...history].reverse().filter((r) => r.stage === "keyframe" && r.shotId === shotId);
  if (rows.length === 0) return false;
  return Boolean(rows[0]!.ok);
}

async function download(url: string, file: string): Promise<string> {
  if (WORKER_RUNTIME) return WORKER_RUNTIME.download(url, file);
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

/** 逐镜视频提交（Seedance 异步任务制） */
function arkVideoBody(options: {
  shotId: string; prompt: string; firstFrame?: string; refs: string[]; seconds: number; generateAudio: boolean; seed?: number;
}): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [{ type: "text", text: options.prompt }];
  if (options.firstFrame) content.push({ type: "image_url", image_url: { url: options.firstFrame }, role: "first_frame" });
  for (const ref of options.refs.slice(0, 3)) {
    if (ref === options.firstFrame) continue;
    content.push({ type: "image_url", image_url: { url: ref }, role: "reference_image" });
  }
  return {
      model: VIDEO_MODEL,
      content,
      duration: options.seconds,
      /**
       * 首帧模式下 Ark 明确拒绝 `ratio`（InvalidParameter.TaskTypeConstraint：
       * "For first-frame or first-last-frame generation, the output ratio follows the first-frame image"）——
       * 画幅由关键帧自己决定，这里只在纯文生视频时才传 ratio。
       */
      ...(options.firstFrame ? {} : { ratio: ASPECT }),
      resolution: SOURCE_RESOLUTION,
      generate_audio: options.generateAudio,
      watermark: false,
      return_last_frame: true,
      ...(options.seed ? { seed: options.seed } : {})
  };
}
async function arkVideo(options: {
  shotId: string; prompt: string; firstFrame?: string; refs: string[]; seconds: number; generateAudio: boolean; seed?: number;
  stage: string; target: string;
}): Promise<{ taskId: string; url: string; lastFrame: string | null }> {
  if (WORKER_RUNTIME) return WORKER_RUNTIME.video(options);
  const body = arkVideoBody(options);
  const endpoint = `${ARK_BASE}/contents/generations/tasks`;
  return resumeOrSubmitVideoTask({ root: GENERATION_ROOTS.videoRoot, legacyRoots: GENERATION_ROOTS.legacyVideoRoots,
    projectId: PROJECT, shotId: options.shotId, body, provider: "ark", endpoint,
    requireExisting: hasPriorFilmGeneration({ projectId: PROJECT, shotId: options.shotId, kind: "video",
      workDirs: GENERATION_ROOTS.evidenceWorkDirs, targets: [options.target] }),
    transport: {
      submit: async request => {
        if (!ARK_KEY) throw new Error("PROVIDER_UNCONFIGURED: 实际视频提交需要方舟密钥");
        const response = await fetch(endpoint, { method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${ARK_KEY}` },
          body: JSON.stringify(request), signal: AbortSignal.timeout(120_000) });
        return { ok: response.ok, status: response.status, text: await response.text() };
      },
      poll: async taskId => {
        if (!ARK_KEY) throw new Error("PROVIDER_UNCONFIGURED: 实际视频查询需要方舟密钥");
        const response = await fetch(`${endpoint}/${encodeURIComponent(taskId)}`, {
          headers: { authorization: `Bearer ${ARK_KEY}` }, signal: AbortSignal.timeout(60_000) });
        return { ok: response.ok, status: response.status, text: await response.text() };
      },
    },
  });
}

/** Paid source reuse checks task, source scope and bytes, never a past quality score. */
function reusableProviderClip(shot: ShotCard, candidates: string[]): ReturnType<typeof findProviderClip> {
  const legacyKey = productionHash({ projectId: PROJECT, shotId: shot.shotId });
  const roots = [...new Set([GENERATION_ROOTS.videoRoot, ...GENERATION_ROOTS.legacyVideoRoots])];
  const files = roots.flatMap(root => [videoTaskReceiptPath(root, PROJECT, shot.shotId), join(root, `${legacyKey}.json`)]);
  const receipts = files.filter(existsSync).map(file => readProviderReceipt(file) as Record<string, unknown>);
  for (const receipt of receipts) {
    if (receipt.schemaVersion === "workloom.video-task-receipt/v2") assertVideoTaskReceiptIdentity(receipt);
    else if (receipt.schemaVersion !== "workloom.video-task-receipt/v1") throw new Error("POST_PROVIDER_RECEIPT_INVALID");
    if (receipt.projectId !== PROJECT || receipt.shotId !== shot.shotId) throw new Error("POST_PROVIDER_RECEIPT_SCOPE_CHANGED");
  }
  if (new Set(receipts.map(receipt => String(receipt.requestSha256))).size > 1
    || new Set(receipts.filter(receipt => receipt.taskId).map(receipt => String(receipt.taskId))).size > 1) {
    throw new Error("VIDEO_TASK_RECEIPT_CONFLICT: reconcile the original request and task; no new POST");
  }
  // Known ACKs resume through the GET-only journal. They are not treated as failed source quality.
  const taskReceipt = receipts.find(receipt => receipt.state === "succeeded");
  if (receipts.length && !taskReceipt || !WORKER_RUNTIME && !taskReceipt) return null;
  return findProviderClip({ projectId: PROJECT, shotId: shot.shotId, sourceHash: sourceHashFor(shot.shotId, "shot"),
    candidates, records: readStageHistory(), ...(taskReceipt ? { taskReceipt } : {}) });
}
function recordProviderSource(shot: ShotCard, file: string, taskId: string, cached: boolean): void {
  const technical = inspectPostInput({ file, ffprobe: FFPROBE });
  rememberInputs("render-source", [file], shot.shotId);
  record({ stage: "render-source", shotId: shot.shotId, invoked: !cached, ok: true, cached, degraded: false,
    attempt: 1, ms: 0, artifact: file,
    evidence: { ...technical, taskId, providerSucceeded: true, qualityReviewed: false,
      providerReceiptKind: WORKER_RUNTIME ? "parent-component-ledger" : "persistent-provider-task" },
    verdict: null, note: "供应商成功片段默认接受；历史质量裁决保留，不改写为质量通过" });
}
function acceptExistingRenderedClip(shot: ShotCard): boolean {
  if (adoptedRenderedClips.has(shot.shotId)) return existsSync(productionClipFile(shot.shotId));
  const clip = join(CLIP_DIR, `${shot.shotId}.mp4`);
  const paid = cachedProviderSources.get(shot.shotId) ?? reusableProviderClip(shot, [join(CLIP_DIR, `${shot.shotId}.raw.mp4`), clip]);
  if (!paid) return false;
  recordProviderSource(shot, paid.file, paid.taskId, true);
  rememberInputs("shot", [paid.file], shot.shotId);
  // The paid source is read only. Frame-rate and audio encoding happen once in compose.
  const finalClip = paid.file;
  const normalized = { factor: 1, from: inspectPostInput({ file: paid.file, ffprobe: FFPROBE }).durationSec,
    to: inspectPostInput({ file: paid.file, ffprobe: FFPROBE }).durationSec, sourceTiming: "preserved" };
  productionClipPaths.set(shot.shotId, finalClip);
  const technical = inspectPostInput({ file: finalClip, ffprobe: FFPROBE });
  record({ stage: "shot", shotId: shot.shotId, invoked: false, ok: true, cached: true, degraded: false,
    attempt: 1, ms: 0, artifact: finalClip, evidence: { ...technical, taskId: paid.taskId, raw: paid.file, normalized, qualityReviewed: false },
    verdict: postAcceptanceVerdict({ stage: "shot", receipts: [technical] }), note: "沿用同一供应商成功任务，不提交新渲染" });
  if (isMaterialShot(shot) && STAGES.has("material-gen")) {
    rememberInputs("material-gen", [paid.file], shot.shotId);
    record({ stage: "material-gen", shotId: shot.shotId, invoked: false, ok: true, cached: true, degraded: false,
      attempt: 0, ms: 0, artifact: finalClip, evidence: { ...technical, taskId: paid.taskId, raw: paid.file,
        qualityReviewed: false, applicable: false, skipReason: "复用原成功渲染，不重复生成素材镜" },
      verdict: postAcceptanceVerdict({ stage: "shot", receipts: [technical] }) });
  }
  adoptedRenderedClips.add(shot.shotId);
  return true;
}

/* ================= 镜头文案与字幕 ================= */

function dialogueText(shot: ShotCard): string {
  return (shot.dialogue ?? []).map((d) => String(d.text ?? "")).filter(Boolean).join(" ");
}
/**
 * 关键帧提示词（薄封装，实现移到 `packages/video-studio/src/plate-prompt.ts` + 单测）。
 *
 * 2026-09-24 真机二次事故：本函数原来内联在脚本里，数组中被残留的 diff 标记 `+` 破坏，
 * 那一行成了 `+"场景结构与物理自洽（通用）：…"` = **NaN**——通用空间/物理不变量从未进过提示词，
 * 进 Ark 的是字面 "NaN"。评审侧有不变量、提示词侧没有，于是"无头之桥"屡次复现。
 * 现在实现搬进模块并加了退化哨兵断言（不得出现 NaN/undefined/[object Object]）+ 桥类结构硬约束测试。
 */
function platePrompt(shot: ShotCard, characterName: string, appearanceText = ""): string {
  return buildPlatePrompt(shot as unknown as PlatePromptShot, {
    characterName,
    appearanceText,
    aspect: ASPECT,
    resolution: SOURCE_RESOLUTION,
    title: shotlist.title, eraProfile: authorContext.eraProfile, ...(sceneBible ? { sceneBible } : {})
  });
}
function buildSrt(): string {
  const lines: string[] = [];
  let cursor = 0;
  /**
   * 按标点与每行约18个汉字生成字幕折行，完整保留全部请求文字。
   * 行数、外观或密度不作为源片质量门，也不因此删字或重生成。
   * 宽度口径：汉字计 1、非汉字计 0.5（与工位的 maxLineCharsZh 口径一致）。
   */
  const wrapCue = (input: string, maxPerLine = 18): string => {
    const chunks = input.split(/(?<=[，。！？；、,.!?;])/).filter((s) => s.trim().length > 0);
    const wrapped: string[] = [];
    let current = "";
    for (const chunk of chunks) {
      const candidate = `${current}${chunk}`;
      const width = [...candidate].reduce((sum, ch) => sum + (/[\u4e00-\u9fff]/.test(ch) ? 1 : 0.5), 0);
      if (current && width > maxPerLine) {
        wrapped.push(current.trim());
        current = chunk;
      } else {
        current = candidate;
      }
    }
    if (current.trim()) wrapped.push(current.trim());
    /**
     * 标点口径（2026-09-25 工位判据 / 2026-09-27 真机修复）：交付字幕**不带标点**，
     * 数字内的 `. : - /` 保留。此前这里只按标点折行、却把标点一并写进 SRT，
     * 烧录模式的 "标点体检" 必然 fail（字幕工位按落盘 SRT 判），母版终审被判 score=0。
     * 折行仍按标点语义分段，落盘前逐行剔除标点，与旁挂模式工位的清洗口径一致。
     */
    const stripCuePunctuation = (line: string): string =>
      line.replace(/[，。！？；、,.!?;:："“”'‘’（）()【】《》—…·]/g, "").replace(/\s{2,}/g, " ").trim();
    return wrapped.map(stripCuePunctuation).filter(Boolean).join("\n");
  };
  postShots().forEach((shot, index) => {
    const duration = postShotSeconds(shot);
    if (index === 0 && OPENING_CAPTION) {
      if (shot.shotId !== OPENING_CAPTION.shotId || dialogueText(shot)) throw new Error("FILM_OPENING_CAPTION_CHANGED：旁挂首句不能替换或新增口播");
      lines.push("1", `${srtTime(OPENING_CAPTION.startSec)} --> ${srtTime(OPENING_CAPTION.endSec)}`, wrapCue(OPENING_CAPTION.text), "");
    }
    const text = dialogueText(shot);
    if (text) {
      /**
       * 时间轴口径（2026-09-25 南昌片真机修正）：字幕起点必须用**真实切点**（`CUT_GRID`，已扣逐刀转场重叠），
       * 而不是"各镜时长累加"。早先末条字幕落在 51.31s、而成片只有 51.07s → 字幕工位抽证据帧失败、
       * 整条烧录被判失败（真机）。末条再夹到成片目标时长内。
       */
      const shotStart = index === 0 ? 0 : (CUT_GRID[index - 1] ?? cursor);
      const start = shotStart + Math.min(0.6, duration * 0.12);
      const end = Math.min(shotStart + duration - 0.35, expectedMasterSeconds - 0.15);
      lines.push(
        String(index + 1),
        `${srtTime(start)} --> ${srtTime(end)}`,
        wrapCue(text),
        ""
      );
    }
    cursor = index === 0 ? duration : Number(((CUT_GRID[index - 1] ?? cursor) + duration).toFixed(3));
  });
  return lines.join("\n");
}
function srtTime(seconds: number): string {
  const hh = String(Math.floor(seconds / 3600)).padStart(2, "0");
  const mm = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const ss = String(Math.floor(seconds % 60)).padStart(2, "0");
  const ms = String(Math.round((seconds % 1) * 1000)).padStart(3, "0");
  return `${hh}:${mm}:${ss},${ms}`;
}

/* ================= 主流程 ================= */

log(`项目 ${PROJECT}｜镜头 ${shots.length} 个｜创作目标 ${totalSeconds}s（${DURATION_POLICY}）｜${ASPECT} 源 ${SOURCE_RESOLUTION} → 交付 ${OUTPUT_RESOLUTION} (${OUTPUT_SIZE.width}x${OUTPUT_SIZE.height})@${FPS}fps`);
log(FILM_COMPLETENESS_PRINCIPLE);
if (["material-gen", "videos"].some(stage => STAGES.has(stage))) {
  for (const shot of shots.filter(requiresGeneration)) renderSecondsWithinCapability(Number(shot.duration), loadModelDurationLimits(VIDEO_MODEL), shot.shotId);
}
log(`媒体工具：ffmpeg=${FFMPEG}｜ffprobe=${FFPROBE}`);
log(`后期缓存：${POST_DIR}｜交付目录：${OUT_DIR}`);
log(`角色档案：${lead ? `${lead.name}（${lead.id}）角度 ${Object.keys(lead.files).join("/")}` : "未找到（人物一致性将降级为文字描述）"}`);
log(`阶段：${[...STAGES].join(" → ")}｜渲染后策略：${REVIEW_POLICY}（执行与溯源错误如实失败）`);
if (DRY_RUN) log("⚠ dry-run：只做脚本/提示词/计划，不出图不出片");

const specReports: Array<Record<string, unknown>> = [];
/** 动作节拍预算（advisory：只报数不拦，避免把"9 个 vs 8 个"这种量级差当成缺陷） */
const motionBudgetNotes: Array<{ shotId: string; beats: number; advice: string }> = [];

interface EnhancementConsumption {
  shotId: string;
  status: ShotIntentStatus;
  verified: boolean;
  detail: string;
  sourceHash: string | null;
  outputHash: string | null;
}

/** Project success requires every shot to pass or explicitly be inapplicable. */
function enhancementStatus(statuses: readonly ShotIntentStatus[]): ShotIntentStatus {
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("unverified")) return "unverified";
  return statuses.includes("passed") ? "passed" : "not_applicable";
}

/** Validate the exact card consumed downstream, not a marker or a historical success row. */
function micromotionConsumption(shot: ShotCard, trace?: MicromotionTrace): EnhancementConsumption {
  const result: EnhancementConsumption = {
    shotId: shot.shotId, status: "unverified", verified: false,
    detail: "缺少当前镜头的微动作证据", sourceHash: null, outputHash: null
  };
  if (!trace) return result;
  try {
    const expected = planMicromotion(shot);
    result.sourceHash = expected.sourceHash;
    result.outputHash = shotIntentHash(shot.action ?? (shot.fields as Record<string, unknown> | undefined)?.action ?? null);
    if (trace.status === "failed") return { ...result, status: "failed", detail: trace.skipped ?? "微动作失败" };
    if (trace.status !== "passed" && trace.status !== "not_applicable") return { ...result, detail: trace.skipped ?? "微动作未验证" };
    if (trace.schemaVersion !== "workloom.micromotion-trace/v1" || trace.policyVersion !== MICROMOTION_POLICY_VERSION
      || !trace.sourceHash || trace.shotId !== shot.shotId || trace.sourceHash !== expected.sourceHash
      || trace.intentHash !== expected.intentHash || trace.status !== expected.status
      || shotIntentHash(trace.applied) !== shotIntentHash(expected.applied) || trace.text !== expected.text
      || !Number.isFinite(trace.charDelta) || trace.charDelta < 0 || trace.charDelta > 200) {
      return { ...result, detail: "微动作版本、原始意图、适用性或应用清单与当前卡片不匹配" };
    }
    if (trace.status === "passed") {
      const action = shot.action;
      if (trace.applied.length === 0 || trace.outputHash !== result.outputHash || typeof action !== "string"
        || !action.endsWith(MICROMOTION_MARKER + trace.applied.map((entry) => entry.clause).join("；"))) {
        return { ...result, detail: "微动作输出哈希或完整应用句未在当前 action 中核到" };
      }
    } else if (trace.applied.length || trace.text || trace.charDelta !== 0) {
      return { ...result, detail: "不适用镜头仍带微动作写入，状态矛盾" };
    }
    return { ...result, status: trace.status, verified: true, detail: trace.status === "passed"
      ? `已核对 ${trace.applied.length} 个适用通道的完整写入、原始意图与 action 哈希`
      : trace.skipped ?? "当前主体与可见部位不适用人物微动作" };
  } catch (error) {
    return { ...result, detail: `微动作消费证据无法核验：${error instanceof Error ? error.message : String(error)}` };
  }
}

/** KB evidence describes actual written fields; proposals and dropped clauses cannot count. */
function cineKbConsumption(shot: ShotCard, trace: Record<string, unknown>, policyVersion: string): EnhancementConsumption {
  const result: EnhancementConsumption = {
    shotId: shot.shotId, status: "unverified", verified: false,
    detail: String(trace.error ?? "摄影知识未验证"), sourceHash: null, outputHash: null
  };
  if (trace.status === "failed") return { ...result, status: "failed", detail: String(trace.error ?? "摄影知识失败") };
  if (trace.status !== "passed" && trace.status !== "not_applicable") return result;
  try {
    const intent = normalizeShotIntent(shot);
    result.sourceHash = intent.sourceHash;
    result.outputHash = shotIntentHash(shot);
    if (trace.schemaVersion !== "workloom.cine-kb-trace/v1" || trace.policyVersion !== policyVersion
      || trace.sourceHash !== intent.sourceHash || trace.intentHash !== shotIntentHash(intent)
      || trace.outputHash !== result.outputHash || !Array.isArray(trace.applied) || !Array.isArray(trace.actualWrittenFields)) {
      return { ...result, detail: "摄影知识版本、原始意图或输出哈希与当前卡片不匹配" };
    }
    const applied = trace.applied as Array<Record<string, unknown>>;
    const fields = applied.map((entry) => entry.field);
    const written = applied.every((entry) => typeof entry.field === "string" && typeof entry.written === "string"
      && entry.written.length > 0 && entry.writtenChars === entry.written.length && !entry.dropped
      && typeof shot[entry.field] === "string" && (shot[entry.field] as string).endsWith(entry.written)
      && entry.fieldHash === shotIntentHash(shot[entry.field]));
    if (!written || new Set(fields).size !== fields.length || shotIntentHash(fields) !== shotIntentHash(trace.actualWrittenFields)
      || (trace.status === "passed" ? applied.length === 0 : applied.length !== 0)) {
      return { ...result, detail: "摄影知识实际写入字段、完整贡献句或逐字段哈希不一致" };
    }
    return { ...result, status: trace.status, verified: true, detail: trace.status === "passed"
      ? `已核对 ${applied.length} 个实际写入字段及当前卡片哈希`
      : "没有适用的新增摄影知识，原卡保持不变" };
  } catch (error) {
    return { ...result, detail: `摄影知识消费证据无法核验：${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * 微动作证据按**镜号**索引，而不是按对象引用：
 * 片型后置复核（`scene-policy-postplan`）会对当前镜头卡重新执行 `applyScenePolicy`，
 * 每次都会返回**新对象**（内容同构）。真机 2026-09-29：对象引用做键 → 后置复核之后
 * G7 的 `micromotion-applied` 判据全部报"缺少当前镜头的微动作证据"，环节被自己的记账方式卡死。
 */
const micromotionTraces = new Map<string, MicromotionTrace>();

/* ---------- ⓪ 摄影知识库注入（监制：cine-kb） ---------- */
/**
 * 为什么放在提示词之前：知识库的价值就在"写提示词前先定关键细节"——
 * 光圈档位、景别、光位、色调、材质先在库里选好，再交给交付闸与提示词融合。
 * 纪律：提示词字段只写**画面语言**；f 值等硬参数只进 trace（KB 检索总则）。
 */
if (generationStageEnabled("cine-kb")) {
  const started = Date.now();
  const kbDir = resolve(arg("--kb-dir", join(REPO_ROOT, "bundles/ai-video/library/cinematography-kb")));
  const bridgePath = join(REPO_ROOT, "bundles/ai-video/connectors/cine-kb-bridge/core.mjs");
  if (!existsSync(bridgePath) || !existsSync(kbDir)) {
    record({
      stage: "cine-kb", shotId: null, invoked: false, ok: false, cached: false, degraded: false, attempt: 1, ms: 0,
      artifact: null, evidence: { status: "unverified", kbDir, bridgePath, exists: { bridge: existsSync(bridgePath), kb: existsSync(kbDir) } },
      verdict: null, note: "请求的摄影知识库或连接器缺失，未验证"
    });
    throw new Error("摄影知识增强未通过：请求的知识库或连接器缺失");
  } else {
    type CineKbCore = {
      CINE_KB_POLICY_VERSION: string;
      loadKb: (dir: string) => Record<string, unknown>;
      kbStatus: (kb: unknown) => Record<string, unknown>;
      enrichShotCard: (kb: unknown, card: unknown, options: { englishGloss: boolean }) => { card: Record<string, unknown>; trace: Record<string, unknown> };
    };
    let core: CineKbCore;
    let kb: Record<string, unknown>;
    let status: { topics: number; entries: number; missingTopics: Array<{ id: string; title: string }> };
    try {
      core = await import(bridgePath) as CineKbCore;
      kb = core.loadKb(kbDir);
      status = core.kbStatus(kb) as typeof status;
    } catch (error) {
      record({
        stage: "cine-kb", shotId: null, invoked: true, ok: false, cached: false, degraded: false, attempt: 1,
        ms: Date.now() - started, artifact: null,
        evidence: { status: "unverified", kbDir, error: error instanceof Error ? error.message : String(error) },
        verdict: null, note: "摄影知识库加载失败，未验证"
      });
      throw error;
    }
    log(`摄影知识库：${status.topics} 篇 / ${status.entries} 条映射${status.missingTopics.length > 0 ? `｜⚠ 缺篇 ${status.missingTopics.map((t) => `${t.id} ${t.title}`).join("、")}` : ""}`);
    const traceDir = join(WORK_DIR, "cine-kb");
    mkdirSync(traceDir, { recursive: true });
    const perShot: EnhancementConsumption[] = [];
    for (const [index, shot] of shots.entries()) {
      if (!requiresGeneration(shot)) continue;
      /**
       * 提示词语言口径（2026-09-24 真机）：分镜卡【语言约束】写明"全部字段必须使用中文"，
       * 因此默认只注入中文短语（英文关键词仍在 trace 里）；
       * 需要英文提示词的模型可由 `--prompt-english-gloss` 显式开启。
       */
      const { card, trace } = core.enrichShotCard(kb, shot, { englishGloss: flag("--prompt-english-gloss") });
      shots[index] = card as ShotCard;
      const consumption = cineKbConsumption(shots[index]!, trace, core.CINE_KB_POLICY_VERSION);
      perShot.push(consumption);
      // Shot ids are labels, not paths; an invalid id cannot escape or overwrite another trace.
      const traceName = `${String(index + 1).padStart(3, "0")}-${String(shot.shotId).replace(/[^\p{L}\p{N}_-]/gu, "_").slice(0, 80) || "shot"}.json`;
      const traceFile = join(traceDir, traceName);
      writeFileSync(traceFile, `${JSON.stringify({ ...trace, consumption, kbDir, kbStatus: status }, null, 2)}\n`, "utf8");
      const advisor = (trace as { apertureAdvisor?: { aperture: string; scenarioLabel: string | null; matchedBy: string } }).apertureAdvisor;
      const fields = ((trace as { applied?: Array<{ field: string; writtenChars: number }> }).applied ?? []).filter((entry) => entry.writtenChars > 0);
      log(`  ${shot.shotId}: ${consumption.status} · 光圈 ${advisor?.aperture ?? "-"}（${advisor?.scenarioLabel ?? "-"}）· 实际写入 ${fields.length} 个字段 → ${fields.map((f) => f.field).join("/") || "无"}`);
      record({
        stage: "cine-kb", shotId: shot.shotId, invoked: true, ok: consumption.verified, cached: trace.reused === true, degraded: false, attempt: 1,
        ms: Date.now() - started, artifact: traceFile,
        evidence: { ...consumption, traceStatus: trace.status, aperture: advisor?.aperture ?? null, scenario: advisor?.scenarioLabel ?? null, matchedBy: advisor?.matchedBy ?? null, injectedFields: fields.map((f) => f.field), missingTopics: status.missingTopics.map((t) => t.id) },
        verdict: null, note: consumption.detail
      });
    }
    const projectStatus = enhancementStatus(perShot.map((entry) => entry.status));
    const ok = perShot.length === shots.filter(requiresGeneration).length && perShot.every((entry) => entry.verified);
    const enrichedFile = join(WORK_DIR, `shotlist-enriched-${PROJECT}.json`);
    writeFileSync(enrichedFile, `${JSON.stringify({ projectId: PROJECT, shots, status: projectStatus, cineKbApplied: perShot.some((entry) => entry.status === "passed"), perShot }, null, 2)}\n`, "utf8");
    // The latest project row cannot let a successful last shot mask an earlier failed/unverified shot.
    record({
      stage: "cine-kb", shotId: null, invoked: true, ok, cached: false, degraded: false, attempt: 1,
      ms: Date.now() - started, artifact: enrichedFile,
      evidence: { status: projectStatus, perShot, textRulesOnly: true }, verdict: null,
      note: "逐镜适用性与写入证据汇总；不代表视频视觉质量通过"
    });
    if (!ok) throw new Error(`摄影知识增强未通过：${perShot.filter((entry) => !entry.verified).map((entry) => `${entry.shotId} ${entry.status}（${entry.detail}）`).join("；")}`);
  }
}

/* ---------- ① 连贯性导演评审（监制：continuity，step_key: continuity） ---------- */
/**
 * 管线 yml 的 `continuity` 环节（位置与 yml 一致：**在提示词融合之前**）。
 *
 * 为什么放这么前：跨镜问题（同一场戏换造型、时段倒退、方向相反、道具凭空出现）在**镜头卡**层面就能查出来，
 * 等到出片才发现要烧一整轮渲染额度。确定性检查在 `packages/video-studio/src/continuity.ts`（6 问 + 5 维评分），
 * LLM 只补"机检查不出的语义跳变"。硬阻断按 yml 纪律**直接打回**（不花钱）。
 */
if (generationStageEnabled("continuity")) {
  const started = Date.now();
  const report = auditContinuity(shots.filter(requiresGeneration) as unknown as Array<Record<string, unknown>>, {
    targetSeconds: null,
    projectId: PROJECT
  });
  const checks: GateCheck[] = report.checks.map((c) => ({ id: c.id, pass: c.pass, detail: c.detail, hard: c.hard }));
  if (!DRY_RUN) {
    const verdict = await reviewStage({
      stage: "continuity", projectId: PROJECT,
      artifacts: [{ path: SHOTS_FILE, kind: "json", note: "镜头卡（跨镜一致性评审对象）" }],
      deterministic: checks,
      context: {
        shotCount: report.shotCount,
        totalSeconds: report.totalSeconds,
        sixQuestions: report.questions.map((q) => `${q.question} → ${q.answer}（${q.note}）`),
        fiveDimensions: report.dimensions.map((d) => `${d.name} ${d.score}/20`),
        deterministicScore: report.score,
        discipline: "硬阻断（打回）：造型无理由不一致、总时长不符、台词重复。其余为软信号，进问题清单但不阻断；"
          + "跨镜判断只看镜头卡文本，不要索要额外画面证据。"
      },
      env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
    });
    record({
      stage: "continuity", shotId: null, invoked: true, ok: verdict.approved, cached: false, degraded: verdict.degraded,
      attempt: 1, ms: Date.now() - started, artifact: SHOTS_FILE,
      evidence: { score: verdict.score, deterministicScore: report.score, blocking: report.blocking, dimensions: report.dimensions, questions: report.questions },
      verdict
    });
    if (!verdict.approved && !ACCEPT_REJECTED.includes("continuity")) {
      log(`⛔ 连贯性导演评审未放行：${verdict.reason}（${verdict.issues.slice(0, 3).join("；")}）`);
      log(`   纪律：本环节在**花钱之前**硬阻断。确需带瑕疵继续，请显式传 --accept-rejected continuity（会留痕）。`);
      process.exit(4);
    }
    if (!verdict.approved) log(`⚠ 连贯性导演评审被打回，但已显式声明带瑕疵放行（--accept-rejected continuity）`);
  } else {
    record({
      stage: "continuity", shotId: null, invoked: false, ok: report.approved, cached: false, degraded: false,
      attempt: 0, ms: Date.now() - started, artifact: SHOTS_FILE,
      evidence: { dryRun: true, deterministicScore: report.score, blocking: report.blocking }, verdict: null
    });
    log(`连贯性（dry-run）：确定性 5 维 ${report.score}/100，硬阻断 ${report.blocking.length} 条`);
  }
}

/* ---------- ①-1 微动作增强（step_key: micromotion，按主体与可见部位判适用性） ---------- */
/**
 * 管线 yml 的 `micromotion` 环节。
 *
 * **与 yml 的顺序差异（显式声明）**：yml 把它排在 G6 之后；这里**前移到提示词融合之前**——
 * 增强的本质是改镜头卡（action 字段），融合之后再改就会绕开刚通过的 G6 审核
 * （"审过的提示词 ≠ 最终提交的提示词"）。前移后 G6 审的就是含微动作的最终稿。
 */
if (generationStageEnabled("micromotion")) {
  const started = Date.now();
  const traces: MicromotionTrace[] = [];
  const perShot: EnhancementConsumption[] = [];
  for (const [index, shot] of shots.entries()) {
    if (!requiresGeneration(shot) || isMaterialShot(shot)) continue;
    const { card, trace } = applyMicromotion(shot as unknown as Record<string, unknown>);
    // Even a reused/N/A result may restore prior owned text. Always consume the returned card.
    shots[index] = card as ShotCard;
    micromotionTraces.set(String(shots[index]!.shotId), trace);
    traces.push(trace);
    perShot.push(micromotionConsumption(shots[index]!, trace));
  }
  const applicable = perShot.every((entry) => entry.verified);
  const bounded = traces.every((t) => Number.isFinite(t.charDelta) && t.charDelta >= 0 && t.charDelta <= 200);
  const languageOnly = !/f\/|ISO|帧率|焦段/.test(traces.map((t) => String(t.text ?? "")).join(" "));
  const checks: GateCheck[] = [
    { id: "intent-and-consumption", pass: applicable, hard: true, detail: applicable ? "每镜适用性、原始意图与实际写入哈希均已核验；合法不适用不增加动作" : perShot.filter((entry) => !entry.verified).map((entry) => `${entry.shotId}：${entry.detail}`).join("；") },
    { id: "bounded-delta", pass: bounded, hard: true, detail: bounded ? `增量均在界内（最大 ${Math.max(0, ...traces.map((t) => Number(t.charDelta ?? 0)))} 字）` : "微动作增量超过 200 字上限" },
    { id: "language-only", pass: languageOnly, hard: true, detail: "微动作只写画面语言（不含 f 值/ISO/帧率等技术参数）" }
  ];
  const traceFile = join(WORK_DIR, `micromotion-${PROJECT}.json`);
  // A dry run executes these deterministic transforms too; preserve their real evidence.
  writeFileSync(traceFile, `${JSON.stringify({ at: stamp(), projectId: PROJECT, traces, perShot, checks, shots: generatedShots(), textRulesOnly: true }, null, 2)}\n`, "utf8");
  const verdict = flag("--micromotion-review") && !DRY_RUN
    ? await reviewStage({
        stage: "micromotion", projectId: PROJECT,
        artifacts: [{ path: traceFile, kind: "json", note: "实际消费的当前镜头卡、适用性与逐字段写入证据" }],
        rubric: [
          "按原始主体与可见部位判适用性：空镜、商品、动物可为 not_applicable；不能要求补齐五路微动作或凑通道数量。",
          "只评审实际写入的动作是否保持源姿态、视线、否定约束与台词节拍：睡眠不睁眼、蹲姿不起身、不笑不加笑意，未出镜部位不补表演。",
          "passed 表示文本与写入证据通过；unverified/failed 必须保留未通过，旧标记或历史成功不能替代当前 sourceHash/outputHash。",
          "本环节只有生成前镜头文本证据，不能据此宣称视频动作自然、人物一致或物理真实；成功源片直接正式后期，不追加实片质量评审。"
        ],
        deterministic: checks,
        context: { traces, perShot, textRulesOnly: true },
        env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
      })
    : null;
  const ok = checks.every((c) => !c.hard || c.pass) && (verdict ? verdict.approved : true);
  const projectStatus = enhancementStatus(perShot.map((entry) => entry.status));
  record({
    stage: "micromotion", shotId: null, invoked: true, ok, cached: false, degraded: Boolean(verdict?.degraded),
    attempt: 1, ms: Date.now() - started, artifact: traceFile,
    evidence: {
      status: !ok && projectStatus !== "failed" && projectStatus !== "unverified" ? "failed" : projectStatus,
      perShot, checks,
      channels: traces.map((t) => ({ shotId: t.shotId, status: t.status, applied: t.applied.length, skipped: t.skipped ?? null, charDelta: t.charDelta })),
      llmReviewed: Boolean(verdict), textRulesOnly: true
    },
    verdict
  });
  if (!ok) {
    throw new Error(`微动作增强未通过自检：${checks.filter((check) => !check.pass).map((check) => check.detail).join("；")}${verdict && !verdict.approved ? `；监制：${verdict.reason}` : ""}`);
  }
  log(`微动作增强：${perShot.filter((entry) => entry.status === "passed").length} 镜实际写入，${perShot.filter((entry) => entry.status === "not_applicable").length} 镜不适用；已核验当前卡片${verdict ? `，监制${verdict.approved ? "放行" : "打回"}` : "（未启用 LLM 文本复评）"}`);
}

/** 摄影知识库和微动作可能重写镜头卡；在真正生成前复核当前完整片型方案。 */
if (scenePolicy) {
  for (let index = 0; index < shots.length; index += 1) if (requiresGeneration(shots[index]!)) shots[index] = applyScenePolicy(shots[index]!, scenePolicy);
  const current = new Map(shots.map((shot) => [shot.shotId, shot]));
  scenePolicyReport = auditScenePolicy({ ...shotlist, shots: shotlist.shots.map((shot) => current.get(shot.shotId) ?? shot) }, scenePolicy);
  scenePolicyReport.policy.selection = scenePolicySelection.reason;
  writeScenePolicyReport();
  /**
   * post-only 组装：片型门是"生成前/生成后"的**创作口径**检查，本模式不生成新镜头，
   * 该结论只作证据留痕（degraded + assemblyMode=post-only），不阻断后期链与交付。
   */
  const postOnlyPostplanDegraded = POST_ONLY_ASSEMBLY && !scenePolicyReport.passed;
  record({ stage: "scene-policy-postplan", shotId: null, invoked: true, ok: scenePolicyReport.passed,
    cached: false, degraded: postOnlyPostplanDegraded, attempt: 1, ms: 0, artifact: SCENE_POLICY_REPORT_FILE,
    evidence: {
      policy: scenePolicy.id, version: scenePolicy.version, defects: scenePolicyReport.defects, ratios: scenePolicyReport.ratios,
      ...(postOnlyPostplanDegraded ? { assemblyMode: "post-only" } : {})
    }, verdict: null });
  if (!scenePolicyReport.passed) {
    const defects = scenePolicyReport.defects.map((item) => `${item.shotId ?? "全片"}[${item.rule}] ${item.detail}`);
    /** post-only 组装：后置片型门同样是"生成前/生成后"的拍摄质量门，不生成新镜头时降级为告警（G-POST1 已留痕） */
    if (POST_ONLY_ASSEMBLY) {
      log(`⚠ ${scenePolicy.title} 后置分镜门禁未过（${defects.length} 项），post-only 组装降级不阻断`);
      for (const defect of defects.slice(0, 4)) log(`   · ${defect}`);
    } else {
      throw new Error(`${scenePolicy.title} 后置分镜门禁未过：${defects.join("；")}`);
    }
  }
}

/** 后续审核与生成共享这份当前镜头快照；每次替换镜头卡后均从 shots 重建视图。 */
const CURRENT_SHOTS_FILE = join(WORK_DIR, `shotlist-current-${PROJECT}.json`);
writeFileSync(CURRENT_SHOTS_FILE, `${JSON.stringify({ projectId: PROJECT, shots }, null, 2)}\n`, "utf8");

/* ---------- ② 脚本 + 提示词交付闸（监制：prompt） ---------- */
if (generationStageEnabled("spec")) {
  const started = Date.now();
  const checks: Array<{ id: string; pass: boolean; detail: string; hard?: boolean }> = [];
  let rateFail = 0;
  /** post-only 字段闸用：声明了主角出镜的镜号（`shotlist.character.appearanceInShots`，缺省为空） */
  const leadAppearanceShotIds = (() => {
    const raw = (shotlist as unknown as { character?: { appearanceInShots?: unknown } }).character?.appearanceInShots;
    return new Set<string>(Array.isArray(raw) ? raw.map(String) : []);
  })();
  for (const shot of shots.filter(requiresGeneration)) {
    /** 素材镜不参与文生提示词融合（它的提示词是"图生视频"的动效提示词，由 material-gen 组装） */
    if (isMaterialShot(shot)) {
      record({
        stage: "spec", shotId: shot.shotId, invoked: false, ok: true, cached: false, degraded: false, attempt: 1, ms: 0,
        artifact: null,
        evidence: { photo: String((shot as Record<string, unknown>).photo), policy: MATERIAL_POLICY_VERSION },
        verdict: null, note: "素材镜：不做文生提示词融合（先按画幅准备素材，再由 material-gen 图生视频出片）"
      });
      continue;
    }
    const duration = Number(shot.duration ?? 0);
    const chars = dialogueText(shot).replace(/[，。！？、,.!?]/g, "").length;
    const rate = duration > 0 ? chars / duration : 0;
    const report = prepareShotPrompt(shot as unknown as Record<string, unknown>, { ratio: ASPECT, resolution: SOURCE_RESOLUTION, fps: FPS });
    /**
     * 提示词语言与引用归一（2026-09-24 真机，6 镜全部命中）：
     *   · 卡片【语言约束】要求全中文，而 vendor 负面约束默认夹带英文（no text / no watermark…）→ 映射成中文等价；
     *   · 角色图引用被写两遍 → 去重。
     * 归一后如仍有长度 ≥3 的拉丁词，写进阶段记录（供审计看到"还剩哪些英文"），不静默忽略。
     */
    const normalized = normalizePromptLanguage(report.prompt);
    /**
     * 镜头卡字段契约回写（2026-09-28 T1 真机监制打回）：
     * vendor 精炼器把 `bright_constraint` 重写成 40 字通用句、并截断 `pacing`/`depth_of_field`/`makeup`/
     * `color_palette` 等字段末句，监制逐条比对合同后判"约束被弱化/口径被删"。这里对**卡片更长的行**逐字回写原文。
     * 场景/道具等扩展类字段行比卡片长，不触发回写。
     */
    const contractFields = [
      { label: "场景", value: mergeUniqueSegments([(shot as Record<string, unknown>).scene, (shot as Record<string, unknown>).sceneDescription]) },
      { label: "明亮约束", value: (shot as Record<string, unknown>).bright_constraint },
      { label: "节奏", value: (shot as Record<string, unknown>).pacing },
      { label: "景深", value: (shot as Record<string, unknown>).depth_of_field },
      { label: "化妆", value: (shot as Record<string, unknown>).makeup },
      { label: "色彩/色调", aliases: ["色彩", "色调"], value: (shot as Record<string, unknown>).color_palette },
      { label: "角色", value: (shot as Record<string, unknown>).character },
      { label: "情绪", value: (shot as Record<string, unknown>).mood },
      { label: "转场", value: (shot as Record<string, unknown>).transition },
      { label: "服装", value: (shot as Record<string, unknown>).costume },
      { label: "构图", value: (shot as Record<string, unknown>).composition },
      { label: "动作", value: (shot as Record<string, unknown>).action },
      { label: "基础", value: (shot as Record<string, unknown>).baseline },
      { label: "导演意图", value: (shot as Record<string, unknown>).director_instruction },
      { label: "灯光设计", aliases: ["灯光/照明", "照明"], value: (shot as Record<string, unknown>).lighting },
    ];
    const contractFixed = restoreCardFieldText(normalized.prompt, contractFields);
    /** 时间轴补全（vendor 组装器会截断末段节拍，实测 6/6 镜） */
    const timelineFixed = restoreTimelineField(contractFixed.prompt, (shot as Record<string, unknown>).timeline);
    /**
     * 台词窗归一到真实镜头时长（2026-09-28 T1 真机监制打回）：
     * vendor `_renderDialogueBlocks` 用 `Math.round(duration)` 算窗，4.5s 镜头被写成 `[00s-05s]`，
     * 与合同「每镜 4.5 秒」冲突，生成端可能照 5s 拉长口播。这里按真实小数时长重排。
     */
    const dialogueFixed = normalizeDialogueWindow(timelineFixed.prompt, duration);
    const finalPrompt = dialogueFixed.prompt;
    specReports.push({
      shotId: shot.shotId, charCount: finalPrompt.length, promptSource: report.promptSource,
      deliveryPass: report.delivery.pass, issues: report.delivery.issues,
      missingSpecFields: report.missingSpecFields, missingP0Fields: report.missingP0Fields,
      redlines: report.redlines, degraded: report.degraded,
      sceneSubstituted: report.sceneSubstituted, sceneSubstitution: report.sceneSubstitution,
      languageNormalized: {
        replacements: normalized.replacements, dedupedRefs: normalized.dedupedRefs,
        remainingLatin: normalized.remainingLatin, timelineRestored: timelineFixed.restored,
        dialogueWindowClamped: dialogueFixed.clamped, dialogueWindowFrom: dialogueFixed.from,
        contractRestored: contractFixed.restored
      }
    });
    /** 【场景】被 vendor 写实校验替换/漂移：必须在运行日志里显性出现（不得静默换掉卡片场景） */
    if (report.sceneSubstituted) {
      log(`  ⚠ ${shot.shotId} ${report.sceneSubstitution?.reason ?? "【场景】与镜头卡不一致"}`);
    }
    if (normalized.replacements > 0 || normalized.dedupedRefs > 0) {
      log(`  ${shot.shotId}: 提示词归一（英文负面词→中文 ${normalized.replacements} 处 · 角色图去重 ${normalized.dedupedRefs} 处）`);
    }
    if (timelineFixed.restored) log(`  ${shot.shotId}: 时间轴补全（组装器截断了第 ${timelineFixed.segments} 段节拍）`);
    if (contractFixed.restored.length > 0) {
      log(`  ${shot.shotId}: 合同字段回写 ${contractFixed.restored.length} 项（${contractFixed.restored.map((item) => `${item.label}+${item.added}字`).join("、")}）`);
    }
    if (dialogueFixed.clamped > 0) {
      log(`  ${shot.shotId}: 台词时间窗归一到本镜时长 ${duration}s（${dialogueFixed.from.join(" / ")} → 修正后窗口已写入提示词）`);
    }
    writeFileSync(join(PROMPT_DIR, `${shot.shotId}.txt`), `${finalPrompt}\n`, "utf8");
    const promptFile = join(PROMPT_DIR, `${shot.shotId}.txt`);
    /**
     * post-only 组装（T-2026-0930-0015）：本片不产出新提示词，"**提示词载体类**检查"（交付闸/字数/
     * 片型约束/语速/台词窗/朝向互斥）不作出厂否决票——素材已经渲出来了，拿去交付。
     * 但 **25 字段 P0 规范**照旧是硬闸：真机事故就是组装卡 `character` 没写主角名/ID，
     * 一路漏到封面才炸（人物卡找不到来源镜）。字段规范与"有没有生成提示词"无关。
     */
    const promptCarrierHard = !POST_ONLY_ASSEMBLY;
    /**
     * post-only 字段闸（只拦"组装卡该有却没有"的字段）：
     *   · `scene` / `duration` 是所有镜头的事实必需项；
     *   · `character` 只在**声明了主角出镜**（`shotlist.character.appearanceInShots` 含本镜，
     *     或卡里已写了人物描述）时才要求写主角名/ID——商品微距、品牌尾卡本来就没有人物。
     * 生成片不改口径（本检查记为咨询项，硬闸仍是"交付闸 + 字数 + 片型约束"）。
     */
    const postOnlyFieldIssues: string[] = [];
    if (POST_ONLY_ASSEMBLY) {
      if (!String(shot.scene ?? "").trim()) postOnlyFieldIssues.push("scene");
      if (!(Number(shot.duration ?? 0) > 0)) postOnlyFieldIssues.push("duration");
      const characterText = String(shot.character ?? "");
      const declaredLead = Boolean(lead) && (leadAppearanceShotIds.has(shot.shotId) || characterText.trim().length > 0);
      const mentionsLead = Boolean(lead) && (characterText.includes(lead!.name) || characterText.includes(lead!.id));
      if (declaredLead && !mentionsLead) postOnlyFieldIssues.push(`character（必须写主角名/ID：${lead!.name}（${lead!.id}））`);
    }
    checks.push({
      id: `p0-fields:${shot.shotId}`,
      pass: POST_ONLY_ASSEMBLY ? postOnlyFieldIssues.length === 0 : report.missingP0Fields.length === 0,
      hard: POST_ONLY_ASSEMBLY,
      detail: POST_ONLY_ASSEMBLY
        ? (postOnlyFieldIssues.length === 0
          ? "post-only 组装：必需字段齐备（scene/duration/主角 character）"
          : `post-only 组装：缺 ${postOnlyFieldIssues.join("、")}——先补镜头卡再出片`)
        : `P0 字段缺失 ${report.missingP0Fields.length} 项（咨询项；生成片以交付闸为准）`
    });
    checks.push({
      id: `delivery:${shot.shotId}`, pass: report.delivery.pass, hard: promptCarrierHard,
      detail: report.delivery.pass ? `交付闸通过（${finalPrompt.length} 字 · ${report.promptSource}）` : `交付闸未过：${report.delivery.issues.join("；")}`
    });
    const primaryPolicyTag = scenePolicy ? shot.policyTags?.find((tag) => scenePolicy.primaryTags.includes(tag)) : undefined;
    const policyPromptPresent = !scenePolicy || (finalPrompt.includes(scenePolicy.prompt.scene)
      && Boolean(primaryPolicyTag && finalPrompt.includes(scenePolicy.prompt.byTag[primaryPolicyTag] ?? "\u0000")));
    checks.push({
      id: `scene-policy-prompt:${shot.shotId}`, pass: policyPromptPresent, hard: promptCarrierHard,
      detail: policyPromptPresent ? "片型场景与景别约束已进入最终视频提示词" : "最终视频提示词缺片型场景或景别约束，禁止生成"
    });
    checks.push({
      id: `char-count:${shot.shotId}`, pass: finalPrompt.length >= 1200, hard: promptCarrierHard,
      detail: `提示词 ${finalPrompt.length} 字（交付口径 ≥1200）`
    });
    checks.push({
      id: `speech-rate:${shot.shotId}`, pass: rate <= 3.6, hard: promptCarrierHard,
      detail: `台词 ${chars} 字 / ${duration}s = ${rate.toFixed(2)} 字每秒（上限 3.6）`
    });
    /**
     * 台词窗闸（2026-09-28 T1 真机监制打回）：提示词里的【台词】时间窗不得超过本镜时长。
     * 归一后理论上必然成立，这里按**产物文本**复核而不是相信上游，防止 vendor 改格式后静默漏修。
     */
    const dialogueWindows = [...finalPrompt.matchAll(/\[(\d+(?:\.\d+)?)s-(\d+(?:\.\d+)?)s\]/g)]
      .filter((item, index, list) => list.findIndex((other) => other[0] === item[0]) === index);
    const windowOverrun = duration > 0 ? dialogueWindows.filter((item) => Number(item[2]) > duration + 1e-9) : [];
    checks.push({
      id: `dialogue-window:${shot.shotId}`, pass: windowOverrun.length === 0, hard: promptCarrierHard,
      detail: dialogueWindows.length === 0
        ? "无台词时间窗（无需核验）"
        : windowOverrun.length > 0
          ? `台词窗 ${windowOverrun.map((item) => item[0]).join("、")} 超出本镜时长 ${duration}s`
          : `台词窗 ${dialogueWindows.map((item) => item[0]).join("、")} 在本镜 ${duration}s 内`
    });
    /**
     * 分镜自相矛盾闸（2026-09-24 SC-02 badcase）：
     * 同一镜里既要"面向镜头/视线交流"又要"转身/回头/背身"是**物理上互斥**的动作要求，
     * 模型每次只能满足一半，于是"这一版背身、下一版换脸"反复打回。
     * 这里在**花钱之前**拦下来：要求拆镜或改成"正面接近/正面站定"。
     */
    /**
     * 朝向互斥闸的判据口径（2026-09-24 真机二次校准）：
     *   · **先剥否定**：「不转身」「不指物」里的"转身"是禁止项，早先被当成要求项（假阳性）；
     *   · **再判顺序**：带时间顺序的动作（先…再…／随后／最后／停下后）是**分步执行**，
     *     不是同刻互斥——"走三步后停下、侧身回眸看向镜头"是正常镜头语言，
     *     真出问题的是"全程正面行进 + 转身侧身"这种没有先后交代的写法。顺序动作降级为提示。
     */
    const actionRaw = `${shot.action ?? ""} ${(shot.camera_movement ?? "")}`;
    const actionText = actionRaw.replace(/(不|没有|勿|避免|不要|禁止)[^，。；、,;]{0,12}/g, " ");
    const wantsFront = /面向镜头|正对镜头|正脸|直视镜头|眼神交流|看向镜头/.test(actionText);
    /** 注意：只把"身体转向"算作互斥；"转头/扭头看镜头"是正常小动作，不算（2026-09-24 修正） */
    const wantsTurn = /转身|回眸|侧身|侧转|背对|背身|转正脸|转回/.test(actionText);
    const sequenced = /先[^。；]{0,24}(再|随后|然后)|随后|然后|之后|最后|再转身|再转回|停下(后|之后)?|停留一拍|走(三|两)步后/.test(actionRaw);
    checks.push({
      id: `pose-contradiction:${shot.shotId}`, pass: !(wantsFront && wantsTurn && !sequenced), hard: promptCarrierHard,
      detail: wantsFront && wantsTurn && !sequenced
        ? "同一镜同时要求「面向镜头/眼神交流」与「转身/回头/侧身」——动作互斥，模型只能满足一半（真机 SC-02 连续 4 次被打回）。请拆成两镜，或改成「正面站定/正面走近」的重述。"
        : wantsFront && wantsTurn && sequenced
          ? "含转身/回眸与正面要求，但有明确时间顺序（先…再…）→ 属分步动作，不判互斥；建议在提示词里保留顺序词"
          : (wantsTurn ? "含转身/回眸（无正面要求或已否定，属可接受的动态）" : "无朝向互斥")
    });
    /**
     * 场景先验风险闸（软信号，2026-09-24 SC-02 badcase 的**真正根因**）：
     * 模型对「桥/栏杆 + 船/河 + 指物」这组语义有强先验——会主动把人演成侧身倚栏指船，
     * 哪怕提示词写着"面向镜头"。文本层查不出矛盾（文字没写侧身），只能靠**场景语义组合**预警。
     * 命中时给监制与设计者一个明确建议：改"正面走近"或去掉指物。
     */
    const sceneText = `${shot.scene ?? ""} ${shot.sceneDescription ?? ""}`;
    /**
     * 判据收紧（2026-09-27 真机 v2 首轮打回）：早先「指」与「水」两处都太宽——
     * ・「指」把**拇指/手指**这类正常手部描述算成"指物"；
     * ・「水」把**水磨石/水泥/水杯**这类材质与器物算成"水岸"。
     * 于是「水磨石地面 + 拇指滑动 + 看向镜头」这种完全正常的口播镜被判成高危构图先验，
     * 监制据此打回（score 62）。现在只认真正的指物动作与真正的水体/桥栏语义。
     */
    const priorRisk = /指(物|向|点|着|了指)|挥(手|动)?示意|递(物|出)|捧起|端(起|着)/.test(actionText)
      && /(水岸|水面|水边|河水|江水|江面|河面|湖面|湖边|海边|岸边|桥|栏杆|船)/.test(sceneText)
      && /面向镜头|看向镜头|正对镜头|正脸|眼神交流/.test(actionText);
    checks.push({
      id: `prior-risk:${shot.shotId}`, pass: !priorRisk, hard: false,
      detail: priorRisk
        ? "高风险构图先验：场景含「桥/栏杆/船/河」且动作含「指物/递物」又要求「正面看镜头」——模型大概率演成侧身倚栏指船（真机 SC-02 因此连续 4 次被打回）。建议：改「正面走近/正面站定」，或删掉指物动作。"
        : "无已知构图先验冲突"
    });
    /** 动作复杂度预算（软信号）：5 秒内节拍过多会让模型每次只满足一部分，表现为"这版动作对、下版表情对" */
    /**
     * 计拍只算**宏观动作节拍**（2026-09-24 真机）：微动作增强会在 action 末尾追加
     * 5 路微动作（面部/眼神/身体/呼吸/融合，用「；」分隔），把它算进节拍会让每镜
     * 平白多出 5–6 拍（真机 15→21），监制据此打回；微动作是质感层，不是叙事节拍。
     */
    const macroAction = actionRaw.split("【微动作】")[0] ?? actionRaw;
    const beats = (macroAction.match(/然后|随后|接着|再|边[^，。]{0,6}边|同时|先[^，。]{0,4}再/g) ?? []).length
      + macroAction.split(/[，,；;]/).filter((s) => s.trim().length > 1).length;
    /**
     * 节拍预算**只作参考信息，不进 PASS/FAIL 清单**（2026-09-24 修正）：
     * 放进确定性检查时，监制会把它当硬闸用（真机：9 个节拍直接打回，而 9 与 8 的差别并不构成缺陷）。
     * 现在改为 context 里的 advisory，监制可据情权衡，不再自动阻断。
     */
    motionBudgetNotes.push({ shotId: shot.shotId, beats, advice: beats > 8 ? "节拍偏多（建议 ≤8），可合并同拍的连续位移" : "节拍在预算内" });
    if (rate > 3.6) rateFail += 1;
    record({
      stage: "spec", shotId: shot.shotId, invoked: true,
      /** post-only 组装：以 25 字段 P0 规范为准（不产出提示词）；生成片：沿用"交付闸 + 字数 + 片型约束"口径 */
      ok: POST_ONLY_ASSEMBLY
        ? postOnlyFieldIssues.length === 0
        : report.delivery.pass && report.charCount >= 1200 && policyPromptPresent,
      cached: false, degraded: report.degraded, attempt: 1, ms: Date.now() - started,
      artifact: promptFile,
      evidence: {
        charCount: report.charCount, promptSource: report.promptSource, missing: report.missingSpecFields,
        missingP0: report.missingP0Fields, postOnlyFieldGate: POST_ONLY_ASSEMBLY,
        sceneSubstituted: report.sceneSubstituted, sceneSubstitution: report.sceneSubstitution
      },
      verdict: null
    });
  }
  writeFileSync(join(PROMPT_DIR, "spec-report.json"), `${JSON.stringify(specReports, null, 2)}\n`, "utf8");
  /**
   * 总时长核对：`--only` 局部重跑时只核对被选中的镜头合计（否则局部重跑永远过不了这一闸）。
   */
  const selectedSeconds = shots.reduce((s, x) => s + Number(x.duration ?? 0), 0);
  const expectedSeconds = ONLY.length > 0 ? selectedSeconds : totalSeconds;
  checks.push({
    id: "duration-total", pass: Math.abs(selectedSeconds - expectedSeconds) < 0.001, hard: true,
    detail: `镜头时长合计 ${selectedSeconds}s（目标 ${expectedSeconds}s${ONLY.length > 0 ? `，局部重跑 ${ONLY.join(",")}` : ""}）`
  });
  /**
   * 全素材项目守卫（T-2026-0925-0001 真机发现，同"全真图"缺口在新版重现）：
   * 当 7 镜全部是**素材镜**（真实照片只作生成输入）时，文生提示词产物是空数组
   * （素材镜的提示词由 material-gen 阶段按"图生视频动效提示词"生成，G6 时还不存在），
   * 把空载体送给监制必然判"无正文"打回；而素材镜的把关门是 **G-MAT1**。
   * 因此这里显式跳过 G6 并留痕（via=skip），既不静默放行，也不让监制去判不适用的载体。
   */
  if (materialShots().filter(requiresGeneration).length === shots.filter(requiresGeneration).length) {
    log(`ℹ️ 全片 ${shots.length} 镜均为素材镜：文生提示词门（G6）不适用，按 skip 留痕（素材镜由 G-MAT1 把关）`);
    record({
      stage: "prompt-package", shotId: null, invoked: false, ok: true, cached: false, degraded: false, attempt: 1, ms: 0,
      artifact: join(PROMPT_DIR, "spec-report.json"),
      evidence: { materialShots: shots.map((s) => s.shotId), skipReason: "全片素材镜（真实素材只作生成输入）" },
      verdict: null, note: "全素材项目：无文生镜 → G6 不适用（素材镜提示词由 material-gen 生成并由 G-MAT1 把关）"
    });
    recordGate({
      stepKey: "g6-prompt-confirm",
      sourceStage: "prompt-package",
      checks: [{ id: "no-generated-shots", pass: true, hard: true, detail: `${shots.length} 镜全部为素材镜（usage=generation-reference）` }],
      shotIds: shots.map((s) => s.shotId),
      softApproved: true,
      via: "skip",
      score: null,
      degraded: false,
      reason: "全素材项目：无文生镜，提示词门不适用",
      evidence: { materialShots: shots.length }
    });
  } else {
  const promptReviewOptions: Omit<ProducerGateOptions, "contracts"> = {
    stage: "prompt", projectId: PROJECT,
    rubric: scenePolicy ? [...PRODUCER_RUBRICS.prompt, scenePolicy.prompt.visualReview] : undefined,
    artifacts: [
      { path: join(PROMPT_DIR, "spec-report.json"), kind: "json" },
      /** 只送**生成镜**的提示词；真实素材段没有提示词文件（硬塞路径会让监制读到空文件） */
      ...promptShots().filter(requiresGeneration).map((s) => ({ path: join(PROMPT_DIR, `${s.shotId}.txt`), kind: "text" as const }))
    ],
    deterministic: checks,
    context: {
      title: shotlist.title, shots: promptShots().length, materialShots: materialShots().map((s) => s.shotId), rateFail,
      scenePolicy: scenePolicyReport ? { id: scenePolicy!.id, version: scenePolicy!.version, ratios: scenePolicyReport.ratios,
        exceptionsApplied: scenePolicyReport.exceptionsApplied } : null,
      /** 节拍预算：只报数不拦（监制可据情权衡，不作 PASS/FAIL） */
      motionBudget: motionBudgetNotes,
      poseContradictionRule: "同一镜「面向镜头」与「转身/侧身/背身」互斥；「桥/栏杆/船/河 + 指物 + 正面」属高漂移先验，建议改正面走近或删指物",
      /**
       * 监制口径说明（2026-09-24 真机修正）：把"哪些是信息、哪些是判据"写清楚——
       * 早先监制把 advisory 的节拍数当硬闸用（21 拍直接打回），而节拍预算的产品口径是"只报数不拦"。
       */
      advisoryRule: "motionBudget 是**参考信息，不构成打回依据**（产品口径：节拍数只报数不拦）；"
        + "打回只能依据：交付闸/字数/语速/朝向互斥/构图先验这些确定性结论，或你把正文逐条读出来的实质缺陷。"
        + "微动作段（action 里【微动作】之后）是质感层，不参与节拍与动作复杂度判断。"
    }, env: ENV,
    allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
  };
  let verdict: ProducerVerdict;
  let scopedReviewFile: string | null = null;
  if (scenePolicy) {
    // The complete ten-shot author contract exceeds the producer adapter's per-call context limit.
    // Review every generated shot with its complete original contract and its own full spec report;
    // aggregate only after all shot verdicts exist. The global deterministic checks remain on G6.
    const scoped: Array<{ shotId: string; verdict: ProducerVerdict }> = [];
    const allShotIds = shots.map((item) => item.shotId);
    for (const shot of promptShots().filter(requiresGeneration)) {
      const report = specReports.find((item) => item.shotId === shot.shotId);
      if (!report) throw new Error(`PROMPT_REVIEW_SCOPE_MISSING: ${shot.shotId}`);
      const reportFile = join(PROMPT_DIR, `spec-report-${shot.shotId}.json`);
      writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      const perShot = await reviewStage({
        ...promptReviewOptions,
        artifacts: [
          { path: reportFile, kind: "json" },
          { path: join(PROMPT_DIR, `${shot.shotId}.txt`), kind: "text" },
        ],
        deterministic: checks.filter((check) => !allShotIds.some((id) => check.id.endsWith(`:${id}`)) || check.id.endsWith(`:${shot.shotId}`)),
        context: { ...promptReviewOptions.context, shotId: shot.shotId },
      });
      scoped.push({ shotId: shot.shotId, verdict: perShot });
    }
    if (scoped.length !== promptShots().filter(requiresGeneration).length) throw new Error("PROMPT_REVIEW_SCOPE_INCOMPLETE");
    scopedReviewFile = join(PROMPT_DIR, "prompt-review-scoped.json");
    writeFileSync(scopedReviewFile, `${JSON.stringify(scoped, null, 2)}\n`, "utf8");
    const approved = scoped.every((item) => item.verdict.approved);
    const failed = scoped.find((item) => !item.verdict.approved);
    verdict = {
      stage: "prompt", status: approved ? "passed" : scoped.some((item) => item.verdict.status === "unverified") ? "unverified" : "failed",
      approved, score: Math.min(...scoped.map((item) => item.verdict.score ?? 0)),
      contractHash: buildProducerReviewContract(filmReviewContracts(filmContractSource)).contractHash,
      evidence: [...scoped.flatMap((item) => item.verdict.evidence ?? []),
        { path: scopedReviewFile, sha256: sha256FileSync(scopedReviewFile), scope: "per-shot-verdicts" }],
      hardFailures: scoped.flatMap((item) => item.verdict.hardFailures.map((issue) => `${item.shotId}: ${issue}`)),
      issues: scoped.flatMap((item) => item.verdict.issues.map((issue) => `${item.shotId}: ${issue}`)),
      suggestions: scoped.flatMap((item) => item.verdict.suggestions.map((itemText) => `${item.shotId}: ${itemText}`)),
      rerun: !approved, via: failed?.verdict.via ?? "llm", model: scoped[0]?.verdict.model,
      ms: scoped.reduce((sum, item) => sum + item.verdict.ms, 0),
      reason: approved ? `${scoped.length} 镜原始合同和完整提示词逐镜监制通过`
        : `${failed!.shotId} 等镜头监制未通过：${failed!.verdict.reason}`,
      degraded: scoped.some((item) => item.verdict.degraded),
    };
  } else {
    verdict = await reviewStage(promptReviewOptions);
  }
  record({
    stage: "prompt-review", shotId: null, invoked: true, ok: verdict.approved, cached: false, degraded: verdict.degraded,
    attempt: 1, ms: verdict.ms, artifact: join(PROMPT_DIR, "spec-report.json"),
    evidence: { score: verdict.score, ...(scopedReviewFile ? { outputFiles: [scopedReviewFile] } : {}) }, verdict
  });
  /** G6 提示词审核（step_key: g6-prompt-confirm）——把 prompt-review 的裁决按门记账 */
  recordGate({
    stepKey: "g6-prompt-confirm",
    sourceStage: "prompt-review",
    checks,
    shotIds: shots.map((s) => s.shotId),
    softApproved: verdict.approved,
    via: verdict.via,
    score: verdict.score,
    degraded: verdict.degraded,
    reason: verdict.reason,
    evidence: { issues: verdict.issues, suggestions: verdict.suggestions, artifacts: `${PROMPT_DIR}/${PROJECT}` }
  });
  if (!verdict.approved) {
    log(`⛔ 监制未放行提示词环节：${verdict.reason}（${verdict.suggestions.join("；")}）`);
    /**
     * 显式放行通道（2026-09-25 补，与 G5/G7/G8 一致）：监制的意见属于**文案层风格问题**、
     * 而交付闸（25 字段/长度/台词/锚点/情绪可见性）已全过时，允许用 `--accept-rejected G6` 留痕放行——
     * 否则单个镜头的文案口味会卡住整条修复链（真机：NC-08 反遮挡约束重跑被文案层意见挡住）。
     */
    const accepted = ACCEPT_REJECTED.includes("G6") || ACCEPT_REJECTED.includes("prompt");
    if (!accepted && !DRY_RUN) process.exit(3);
    if (accepted) {
      log(`⚠ 提示词门带瑕疵放行（显式 --accept-rejected G6）：${verdict.reason.slice(0, 120)}`);
      record({
        stage: "prompt-acknowledge", shotId: null, invoked: true, ok: true, cached: false, degraded: true,
        attempt: 1, ms: 0, artifact: join(PROMPT_DIR, "spec-report.json"),
        evidence: { score: verdict.score, reason: verdict.reason, suggestions: verdict.suggestions.slice(0, 5), acceptedBy: "ACCEPT_REJECTED(G6)" },
        verdict: null, note: "提示词门带瑕疵放行（监制文案层意见，交付闸全过；显式留痕）"
      });
    }
  }
}
}

/* ---------- ② 关键帧（监制：keyframe，逐镜视觉评审 + 打回重跑） ---------- */
if (generationStageEnabled("plates")) {
  /**
   * 关键帧锚点策略（2026-09-24 真机定论，见 `docs/producer-gate-design.md` §四·2）：
   *
   * Ark 对**视频输入图**做隐私血缘校验：由真人照片图生图而来的图会被永久标记
   * `InputImageSensitiveContentDetected.PrivacyInformation`（base64 与托管 URL 都被拒），
   * 而**纯文生图产物**可以被 Seedance 直接当首帧（探针 E/F 对照实测）。
   *
   * 因此默认 `--plate-anchor-mode none`：关键帧走纯文生图（人物外貌由角色档案文本给出），
   * 出片可用；`real` 模式（挂真人照片图生图）人更像，但**不能进 Seedance**，
   * 只适合定妆照/角色档案资产与本地渲染。要两者兼得必须先把真人授权进 Ark 私域人像库（asset://）。
   */
  const plateAnchorMode = arg("--plate-anchor-mode", "none");
  const portraitRefs = lead ? ["closeup", "front", "threeQuarter", "side"].map((a) => lead.files[a]).filter(Boolean) as string[] : [];
  const venueRefs = shots.length > 0 && Array.isArray((shots[0] as Record<string, unknown>).venueRefs)
    ? ((shots[0] as Record<string, unknown>).venueRefs as string[]).map(abs).filter(existsSync)
    : [];
  for (const shot of shots.filter(requiresGeneration)) {
    const plate = join(PLATE_DIR, `${shot.shotId}-plate.png`);
    /** 素材镜没有文生关键帧（首帧就是真实素材本身），但仍要有"素材准备件"与提示词 */
    if (isMaterialShot(shot)) {
      record({
        stage: "keyframe", shotId: shot.shotId, invoked: false, ok: true, cached: false, degraded: false, attempt: 1, ms: 0,
        artifact: null, evidence: { photo: String((shot as Record<string, unknown>).photo), skipReason: "素材镜：首帧=真实素材" },
        verdict: null, note: "素材镜：跳过文生关键帧（首帧由真实素材经画幅准备后提供，见 material-gen）"
      });
      continue;
    }
    /**
     * 授权真人素材镜：Seedream 图片接口不接受 `asset://`（真机 400 invalid url），
     * 且**关键帧本来就不该有脸**——人物身份由 Seedance 参考图承担（见 videos 阶段）。
     * 这里如实记录"跳过文生关键帧"，不产出任何 AI 生成的人脸首帧。
     */
    if (isAssetShot(shot)) {
      record({
        stage: "keyframe", shotId: shot.shotId, invoked: false, ok: true, cached: false, degraded: false, attempt: 1, ms: 0,
        artifact: null,
        evidence: { assetRef: assetRefOf(shot), skipReason: "授权真人素材镜：人物身份由 Seedance 参考图承担，不产文生关键帧" },
        verdict: null, note: "授权真人素材镜：跳过文生关键帧（Seedream 不接受 asset://；首帧会顶掉真人身份）"
      });
      continue;
    }
    /**
     * 关键帧缓存必须过**两道失效判据**（2026-09-26 真机 T-2026-0926-0007）：
     *
     *  1. **提示词指纹**：出图时写 `GR-xx.plate-meta.json`（prompt sha256 + 锚点模式 + 模型）。
     *     镜头卡改过（例如把西装改成档案 w1 旗袍）后，旧图必须重出——早先只看"文件在 + >50KB"
     *     就复用，真机表现为"改了卡片，产物还是旧图，却被记成 ok"。
     *  2. **历史裁决**：本镜最近一次 keyframe 记录必须是 ok。被监制打回过的图不得因为
     *     重跑一次就被"缓存复用"洗白（与 shot 阶段"复用也要复检"同一纪律）。
     *
     * 两条任一不满足 → 判缓存失效，照常重新出图并重新过监制。
     */
    const cachedPlateExists = existsSync(plate);
    const cachedMeta = readPlateMeta(shot.shotId);
    const basePlatePrompt = platePrompt(shot, lead?.name ?? "主角", lead?.appearanceText ?? "");
    const anchors = plateAnchorMode === "real"
      ? ([portraitRefs[0], portraitRefs[1], venueRefs[0]].filter(Boolean) as string[])
      : venueRefs.slice(0, 1);
    const imageSize = ENV.SEEDREAM_SIZE ?? "2K";
    const currentPromptSha = createHash("sha256").update(basePlatePrompt).digest("hex");
    const platePromptFile = join(PROMPT_DIR, `${shot.shotId}.plate.txt`);
    writeFileSync(platePromptFile, `${basePlatePrompt}\n`, "utf8");
    rememberInputs("keyframe", [platePromptFile, ...anchors], shot.shotId);
    const currentRequestSha = plateRequestSha256({
      prompt: basePlatePrompt, model: IMAGE_MODEL, anchorMode: plateAnchorMode, size: imageSize,
      referenceSha256: anchors.map((file) => createHash("sha256").update(readFileSync(file)).digest("hex"))
    });
    const cacheDecision = decidePlateCache({
      exists: cachedPlateExists,
      sizeBytes: cachedPlateExists ? statSync(plate).size : 0,
      meta: cachedMeta,
      currentPromptSha256: currentPromptSha,
      currentRequestSha256: currentRequestSha,
      currentArtifactSha256: cachedPlateExists ? createHash("sha256").update(readFileSync(plate)).digest("hex") : null,
      anchorMode: plateAnchorMode,
      lastApproved: lastKeyframeApproved(readStageHistory(), shot.shotId)
    });
    const plateCacheValid = RESUME && cacheDecision.valid && artifactReusable("keyframe", plate, undefined, shot.shotId);
    if (plateCacheValid) {
      const probeInfo = probe(plate);
      record({
        stage: "keyframe", shotId: shot.shotId, invoked: true, ok: true, cached: true, degraded: false, attempt: 1, ms: 0,
        artifact: plate, evidence: { ...probeInfo, promptSha256: currentPromptSha, anchorMode: plateAnchorMode }, verdict: null,
        note: `复用已有产物（${cacheDecision.reason}）`
      });
      continue;
    }
    if (cachedPlateExists && !plateCacheValid) {
      const reason = RESUME ? cacheDecision.reason : "本次禁用复用（--no-resume）";
      log(`  ↻ ${shot.shotId} 关键帧缓存失效（${reason}）→ 按持久受理回执恢复；缺失或未知受理不自动重交`);
      record({
        stage: "keyframe-cache-invalid", shotId: shot.shotId, invoked: false, ok: false, cached: true, degraded: false, attempt: 0, ms: 0,
        artifact: plate, evidence: { reason, cachedPromptSha256: cachedMeta?.promptSha256 ?? null, currentPromptSha256: currentPromptSha }, verdict: null,
        note: `缓存失效（${reason}）：旧图不得直接复用`
      });
    }
    if (DRY_RUN) {
      record({ stage: "keyframe", shotId: shot.shotId, invoked: false, ok: true, cached: false, degraded: false, attempt: 0, ms: 0, artifact: null, evidence: { dryRun: true, prompt: basePlatePrompt, eraProfile: authorContext.eraProfile }, verdict: null });
      continue;
    }
    let approved = false;
    /** 关键帧阶段同样记录上一轮裁决，用于"带变更"重试 */
    let plateVerdict: ProducerVerdict | null = null;
    for (let attempt = 1; attempt <= 1 && !approved; attempt += 1) {
      const started = Date.now();
      try {
        const prompt = basePlatePrompt
          /**
           * 关键帧重试同样"带变更"：把上一轮监制的具体问题写进去（原来只有一句泛泛的"构图更准"）。
           */
          + (attempt > 1 ? `\n${retryInstruction(plateVerdict, attempt, MAX_ATTEMPTS)}` : "");
        writeFileSync(platePromptFile, `${prompt}\n`, "utf8");
        rememberInputs("keyframe", [platePromptFile, ...anchors], shot.shotId);
        if (plateAnchorMode === "real" && attempt === 1) {
          log(`  ⚠ ${shot.shotId} 关键帧挂了真人锚点：产物会被 Seedance 隐私校验拒（仅适合做档案资产）`);
        }
        const url = await arkImage(prompt, anchors, imageSize, shot.shotId, plate);
        saveHostedUrl(shot.shotId, url);
        await download(url, plate);
        const info = probe(plate);
        const width = Number(info.width ?? 0); const height = Number(info.height ?? 0);
        const ratio = width && height ? width / height : 0;
        const [aspectWidth, aspectHeight] = ASPECT.split(":").map(Number);
        const expected = aspectWidth! / aspectHeight!;
        if (!(width > 0) || !(height > 0)) throw new Error("KEYFRAME_NOT_OPENABLE: generated image has no readable image stream");
        const verdict = REVIEW_POLICY === "off" ? postAcceptanceVerdict({ stage: "keyframe" }) : await reviewStage({
          stage: "keyframe", projectId: PROJECT,
          rubric: scenePolicy ? [...PRODUCER_RUBRICS.keyframe, scenePolicy.prompt.visualReview] : undefined,
          artifacts: [{ path: plate, kind: "image", bytes: Number(info.bytes ?? 0), probe: info }],
          deterministic: [
            { id: "bytes", pass: Number(info.bytes ?? 0) > 50_000, detail: `文件 ${((Number(info.bytes ?? 0)) / 1024).toFixed(0)}KB`, hard: true },
            { id: "aspect", pass: Math.abs(ratio - expected) < 0.06, detail: `${width}x${height}（期望比例 ${expected.toFixed(3)}，实测 ${ratio.toFixed(3)}）`, hard: true }
          ],
          referenceImages: localReviewRefsEarly(portraitRefs).slice(0, 2), context: { shotId: shot.shotId, scene: shot.scene, action: shot.action,
            scenePolicy: scenePolicy ? { id: scenePolicy.id, tags: shot.policyTags, speechScene: shot.speechScene } : null }, env: ENV,
          allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
        });
        record({
          stage: "keyframe", shotId: shot.shotId, invoked: true, ok: verdict.approved, cached: false, degraded: verdict.degraded,
          attempt, ms: Date.now() - started, artifact: plate, evidence: info, verdict
        });
        /** 放行才写指纹：被驳回的图不写元文件，下一轮必然重出（缓存失效判据 ② 的物证） */
        if (verdict.approved) writePlateMeta(shot.shotId, prompt, plateAnchorMode, basePlatePrompt, currentRequestSha, plate);
        approved = verdict.approved;
        if (!approved) plateVerdict = verdict;
        if (!approved) log(`↻ 关键帧 ${shot.shotId} 第 ${attempt} 次未过监制：${verdict.reason}`);
      } catch (err) {
        record({
          stage: "keyframe", shotId: shot.shotId, invoked: true, ok: false, cached: false, degraded: false, attempt,
          ms: Date.now() - started, artifact: null, evidence: { error: err instanceof Error ? err.message.slice(0, 300) : String(err) }, verdict: null
        });
        throw err;
      }
    }
    if (!approved) throw new Error(`KEYFRAME_ACCEPTANCE_FAILED: ${shot.shotId}; original paid acceptance retained; no automatic resubmission`);
  }
}

/* ---------- ②-2 素材镜生成：提交能力前置，源表演原速完整保留 ---------- */
function renderSecondsFor(durationSec: number): number {
  return renderSecondsWithinCapability(durationSec, loadModelDurationLimits(VIDEO_MODEL));
}

if (STAGES.has("surface-repair")) {
  const shot = shots.find(item => item.shotId === ONLY[0]);
  if (!shot) throw new Error("SURFACE_REPAIR_SHOT_REQUIRED: 缺指定镜头");
  const paid = reusableProviderClip(shot, [join(CLIP_DIR, `${shot.shotId}.raw.mp4`), join(CLIP_DIR, `${shot.shotId}.mp4`)]);
  if (!paid) throw new Error("POST_PROVIDER_PROVENANCE_REQUIRED: 缺同一成功任务及原片摘要");
  const inputClip = paid.file, taskId = paid.taskId;
  const directory = join(WORK_DIR, "surface-repair", PROJECT, shot.shotId, randomUUID());
  const inspected = inspectSurfaceRepair({ ffmpeg: FFMPEG, ffprobe: FFPROBE, input: inputClip, directory,
    projectId: PROJECT, shotId: shot.shotId, taskId, sourceHash: sourceHashFor(shot.shotId, "shot") });
  const localization = postAcceptanceVerdict({ stage: "shot" });
  localization.evidence = [inspected.planFile, ...inspected.previews].map(file => ({ path: file, sha256: fingerprintArtifact(file).sha256, scope: "explicit-local-transform-input" }));
  const started = Date.now(), output = join(directory, `${shot.shotId}.screen-repaired.mp4`);
  rememberInputs("surface-repair", [inputClip, inspected.planFile, inspected.plan.maskFile], shot.shotId);
  const repaired = executeSurfaceRepair({ ffmpeg: FFMPEG, ffprobe: FFPROBE, ...inspected, localization, output });
  const technical = inspectPostInput({ file: output, ffprobe: FFPROBE });
  record({ stage: "surface-repair", shotId: shot.shotId, invoked: true, ok: true, cached: false, degraded: false,
    attempt: 1, ms: Date.now() - started, artifact: output, evidence: { ...repaired, taskId, qualityReviewed: false,
      original: inputClip, originalSha256: inspected.plan.inputSha256, plan: inspected.planFile, maskSha256: inspected.plan.maskSha256 },
    verdict: postAcceptanceVerdict({ stage: "shot", receipts: [technical] }) });
  log(`明确请求的局部后期副本完成：${output}；原片保留，无身份/质量评审或新渲染`);
}

if (STAGES.has("identity-check")) {
  const shot = shots.find(item => item.shotId === ONLY[0]);
  if (!shot || !acceptExistingRenderedClip(shot)) throw new Error("POST_PROVIDER_PROVENANCE_REQUIRED: 缺同一成功任务的来源和产物字节");
  log("identity-check 为兼容入口：记录供应商成功默认接受；未做身份、服装或画面评审");
}

if (STAGES.has("material-gen")) {
  for (const shot of FIRST_PASS_ORDER.filter(item => isMaterialShot(item))) {
    if (cachedProviderSources.has(shot.shotId) && acceptExistingRenderedClip(shot)) continue;
    const started = Date.now(), card = shot as Record<string, unknown>, spec = readMaterialSpec(card);
    const photo = abs(spec.photo), clip = productionClipFile(shot.shotId), duration = Number(shot.duration ?? 5);
    const rawClip = join(CLIP_DIR, `${shot.shotId}.raw.mp4`), prepared = join(PLATE_DIR, `${shot.shotId}-material.jpg`);
    const promptFile = join(PROMPT_DIR, `${shot.shotId}.txt`);
    try {
      const reused = reusableProviderClip(shot, [rawClip, clip]);
      let taskId: string;
      if (reused) {
        taskId = reused.taskId;
        recordProviderSource(shot, reused.file, taskId, true);
        if (reused.file !== rawClip) copyFileSync(reused.file, rawClip);
      } else {
        if (MATERIAL_POST_ONLY) throw new Error("MATERIAL_RENDER_RECEIPT_REQUIRED: 纯后期不能新提交生成");
        if (!existsSync(photo)) throw new Error(`MATERIAL_REFERENCE_MISSING：${shot.shotId}`);
        copyFileSync(photo, prepared);
        const person = realPersons.get(shot.shotId);
        const reference = buildRenderReferences({ shot: card, productImage: dataUrl(photo), asset: person?.asset });
        const prompt = `${reference.prompt}\n\n${buildMaterialScenePrompt(card, {
          aspect: ASPECT, resolution: SOURCE_RESOLUTION, durationSec: duration, title: shotlist.title, motionStrength: "standard",
        })}`;
        writeFileSync(promptFile, `${prompt}\n`, "utf8");
        const materialSha = sha256FileSync(photo);
      const submitGate = recordGate({
        stepKey: "material-generate",
        sourceStage: "material-gen",
        shotIds: [shot.shotId],
        checks: [
          { id: "material-usage-declared", pass: spec.usage === "generation-reference", hard: true, detail: `用途声明 ${spec.usage}（只允许 generation-reference；禁止静态直出）` },
          { id: "material-file", pass: existsSync(photo) && statSync(photo).size > 20_000, hard: true, detail: `真实素材 ${basename(photo)}（${(statSync(photo).size / 1024).toFixed(0)}KB，sha256 ${materialSha.slice(0, 12)}）` },
          { id: "material-prepared", pass: existsSync(prepared) && sha256FileSync(prepared) === materialSha, hard: true, detail: "完整参考原图已保留，未裁切屏幕/机身；只作生成输入，输出画幅由请求ratio锁定" },
          {
            id: "prompt-ready", pass: prompt.trim().length >= 400, hard: true,
            detail: `素材镜提示词 ${prompt.trim().length} 字（场景构建口径：实景依据 + 自选机位 + 视差 + 环境运动）`
          },
          {
            /**
             * 口径升级（material-scene/v1）：判据从"禁止静态直出"改为"必须以实景依据构建视频场景"——
             * 提示词里必须出现 ① 实景依据 ② 构建视频场景 ③ 不得复刻参考图构图 ④ 禁止贴图式运动/静止画面。
             */
            id: "scene-construction-policy",
            pass: prompt.includes("实景依据") && prompt.includes("构建一段")
              && prompt.includes("不得复刻参考图的构图") && prompt.includes("贴图式运动") && prompt.includes("画面全程静止"),
            hard: true,
            detail: "提示词含「实景依据 / 构建视频场景 / 不得复刻参考图构图 / 禁止贴图式运动与静止画面」四条硬约束"
          },
          { id: "aspect-constraint", pass: prompt.includes(ASPECT), hard: true, detail: `含画幅约束 ${ASPECT}` },
          { id: "duration-limit", pass: duration > 0 && duration <= 30, hard: true, detail: `单镜时长 ${duration}s（上限 30s）` }
        ],
        evidence: {
          mode: "submit", policy: MATERIAL_POLICY_VERSION, material: photo, materialSha256: materialSha,
          promptFile, promptChars: prompt.trim().length, model: VIDEO_MODEL, seconds: duration
        }
      });

        if (!submitGate.approved) throw new Error(`MATERIAL_SUBMIT_BLOCKED：${shot.shotId} ${submitGate.reason}`);
        if (DRY_RUN) {
          record({ stage: "material-gen", shotId: shot.shotId, invoked: false, ok: true, cached: false, degraded: false,
            attempt: 1, ms: 0, artifact: null, evidence: { dryRun: true }, verdict: null });
          continue;
        }
        preflightSubmitGuard({ shotId: shot.shotId, stage: "material-gen", prompt, fps: FPS, attempt: 1, prevFingerprint: null });
        const submitted = await arkVideo({ stage: "material-gen", shotId: shot.shotId, target: rawClip,
          prompt, refs: reference.refs, seconds: renderSecondsFor(duration), generateAudio: ENV.SEEDANCE_GENERATE_AUDIO !== "0", seed: 20260926 });
        await download(submitted.url, rawClip);
        taskId = submitted.taskId;
        recordProviderSource(shot, rawClip, taskId, false);
      }
      rememberInputs("material-gen", [rawClip], shot.shotId);
      if (rawClip !== clip) copyFileSync(rawClip, clip);
      const normalized = { factor: 1, from: inspectPostInput({ file: rawClip, ffprobe: FFPROBE }).durationSec,
        to: inspectPostInput({ file: clip, ffprobe: FFPROBE }).durationSec, sourceTiming: "preserved" };
      const speedRamp = null, cameraMove = null;
      const technical = inspectPostInput({ file: clip, ffprobe: FFPROBE });
      const verdict = postAcceptanceVerdict({ stage: "shot", receipts: [technical] });
      recordGate({ stepKey: "material-generate", sourceStage: "material-gen", shotIds: [shot.shotId],
        checks: [{ id: "provider-success", pass: true, hard: true, detail: `同一供应商成功任务 ${taskId}；原片默认接受，无质量评审` }],
        evidence: { mode: "verify", taskId, policy: POST_RENDER_ACCEPTANCE_POLICY, qualityReviewed: false, rawClip, outputSha256: technical.sha256 } });
      record({ stage: "material-gen", shotId: shot.shotId, invoked: !reused, ok: true, cached: Boolean(reused), degraded: false,
        attempt: 1, ms: Date.now() - started, artifact: clip,
        evidence: { ...technical, taskId, model: VIDEO_MODEL, raw: rawClip, outputFiles: [rawClip], normalized, speedRamp, cameraMove,
          qualityReviewed: false, policy: POST_RENDER_ACCEPTANCE_POLICY }, verdict,
        note: "成功渲染默认接受并完成正式后期；不做静态/运动/身份/服装/对白质量打回或自动重渲" });
    } catch (error) {
      record({ stage: "material-gen", shotId: shot.shotId, invoked: true, ok: false, cached: false, degraded: false, attempt: 1,
        ms: Date.now() - started, artifact: null, evidence: { error: error instanceof Error ? error.message : String(error) }, verdict: null });
      throw error; // Missing input, provider failure, or actual post failure never becomes a second paid submit.
    }
  }
}

/* ---------- ③ 逐镜视频（监制：shot） ---------- */

if (STAGES.has("videos")) {
  /**
   * G7 预生产最终确认（step_key: g7-preproduction）。
   *
   * 位置：**关键帧全部放行之后、第一次提交渲染之前**。这是"花钱之前的最后一道门"：
   * 确认提示词稿与关键帧稿都齐备且都放行过，才允许把请求发给 Seedance。
   * 判据全部看**产物 + 历史裁决**（支持分段重跑：只跑 videos 时，plate/prompt 的放行记录在 stages.jsonl 里）。
   */
  if (shots.some(shot => requiresGeneration(shot) && !isMaterialShot(shot))) {
  const gateHistory = readStageHistory();
  /**
   * 素材镜不产出文生关键帧，G7 的**提示词**判据对"生成镜 + 授权真人素材镜"成立
   * （素材镜由 G-MAT1 门管，授权真人素材镜由下方 external-asset-shots 判据管）。
   */
  const promptReady = promptShots().filter(requiresGeneration).every((s) => {
    const file = join(PROMPT_DIR, `${s.shotId}.txt`);
    return existsSync(file) && readFileSync(file, "utf8").trim().length >= 1200;
  });
  /** 授权真人素材镜就绪判据：引用格式合法 + 提示词齐备（≥1200 字）；**不要求关键帧**（这类镜头本就不产） */
  const assetShotDetail = assetShots().filter(requiresGeneration).map((s) => {
    const file = join(PROMPT_DIR, `${s.shotId}.txt`);
    const promptOk = existsSync(file) && readFileSync(file, "utf8").trim().length >= 1200;
    return { shotId: s.shotId, ref: assetRefOf(s), ok: isAssetRefLocal(assetRefOf(s)) && promptOk };
  });
  const assetShotsReady = assetShotDetail.every((entry) => entry.ok);
  const plateReady = generatedShots().filter(requiresGeneration).every((s) => {
    const plate = join(PLATE_DIR, `${s.shotId}-plate.png`);
    return existsSync(plate) && statSync(plate).size > 50_000;
  });
  const promptApproved = promptShots().filter(requiresGeneration).length === 0 || stageApproved("prompt-review", [null], gateHistory);
  /**
   * 关键帧放行判据（2026-09-27 真机 v2 修正）：**放行必须晚于磁盘上这一版关键帧**。
   *
   * 事故：某镜在上一轮被放行（历史里有 ok 记录），本轮提示词变更 → 关键帧缓存失效 → 重渲 3 次全部被打回，
   * 但失败产物**覆盖了磁盘上的文件名**；G7 只看历史里的 ok 记录 → 误判"已放行"，
   * 于是用一版**从未被放行的关键帧**去渲染视频（最贵的环节）。判据改为"该镜存在 ok 记录且记录时间 ≥ 关键帧文件 mtime"。
   */
  const plateApprovedDetail = generatedShots().filter(requiresGeneration).map((shot) => {
    const plate = join(PLATE_DIR, `${shot.shotId}-plate.png`);
    const ok = artifactReusable("keyframe", plate, undefined, shot.shotId);
    return { shotId: shot.shotId, ok, reason: ok ? "当前关键帧哈希与最新通过裁决一致" : "缺少当前关键帧的最新通过裁决" };
  });
  const plateApproved = plateApprovedDetail.every((entry) => entry.ok);
  /**
   * 素材镜就绪判据（2026-09-25 口径修订）：**不是"有文件就行"**，而是要求
   * ① 片段在盘上；② G-MAT1 的 **verify 事件**存在（证明做过生成溯源 + 复用度实测 + 监制评审）。
   * 只看文件会把"静态直出的照片段"当成合格产物——这正是上一版翻车的地方。
   */
  const gateStepKeyOf = (r: Record<string, unknown>): string | null => String(
    (r as { stepKey?: unknown }).stepKey ?? ((r as { evidence?: { stepKey?: unknown } }).evidence?.stepKey) ?? ""
  ) || null;
  const gateShotIdsOf = (r: Record<string, unknown>): string[] => {
    const top = (r as { shotIds?: unknown }).shotIds;
    if (Array.isArray(top)) return top as string[];
    const inner = (r as { evidence?: { shotIds?: unknown } }).evidence?.shotIds;
    return Array.isArray(inner) ? (inner as string[]) : [];
  };
  const gateModeOf = (r: Record<string, unknown>): string | null => String(
    (r as { evidence?: { mode?: unknown } }).evidence?.mode ?? ""
  ) || null;
  const materialGateVerified = (shotId: string): boolean => acceptExistingRenderedClip(shots.find(shot => shot.shotId === shotId)!);
  const materialReady = materialShots().filter(requiresGeneration).every((s) => {
    const clip = productionClipFile(s.shotId);
    return existsSync(clip) && materialGateVerified(s.shotId);
  });
  const micromotionEvidence = STAGES.has("micromotion")
    ? promptShots().filter(requiresGeneration).map((shot) => micromotionConsumption(shot, micromotionTraces.get(String(shot.shotId))))
    : [];
  const micromotionReady = !STAGES.has("micromotion") || micromotionEvidence.every((entry) => entry.verified);
  const g7 = recordGate({
    stepKey: "g7-preproduction",
    sourceStage: "keyframe",
    shotIds: shots.filter(requiresGeneration).map((s) => s.shotId),
    checks: [
      { id: "prompt-files", pass: promptReady, hard: true, detail: promptReady ? `${promptShots().filter(requiresGeneration).length} 个文生镜头（生成镜 + 授权真人素材镜）提示词齐备且 ≥1200 字（另有 ${materialShots().filter(requiresGeneration).length} 个素材镜走 material-gen 的动效提示词）` : "有生成镜/授权真人素材镜缺提示词或字数不足 1200" },
      { id: "plate-files", pass: plateReady, hard: true, detail: plateReady ? `${generatedShots().filter(requiresGeneration).length} 个生成镜关键帧齐备（>50KB）` : "有生成镜关键帧缺失或过小" },
      {
        id: "external-asset-shots", pass: assetShotsReady, hard: true,
        detail: assetShots().filter(requiresGeneration).length === 0
          ? "本片无授权真人素材镜（不适用）"
          : assetShotsReady
            ? `${assetShots().filter(requiresGeneration).length} 个授权真人素材镜就绪：${assetShotDetail.map((e) => `${e.shotId}→${e.ref}（提示词齐备，无文生关键帧）`).join("；")}——外部素材 ID，未向平台核验授权有效性`
            : `授权真人素材镜未就绪：${assetShotDetail.filter((e) => !e.ok).map((e) => e.shotId).join("、")}`
      },
      { id: "prompt-approved", pass: promptApproved, hard: true, detail: promptApproved ? "提示词环节有放行裁决（历史/本轮）" : "提示词环节无放行裁决" },
      {
        id: "plates-approved", pass: plateApproved, hard: true,
        detail: plateApproved
          ? `每镜关键帧均有**晚于该文件**的放行裁决（${plateApprovedDetail.filter((e) => e.ok).length}/${generatedShots().filter(requiresGeneration).length}）`
          : `有镜头关键帧缺少有效放行：${plateApprovedDetail.filter((e) => !e.ok).map((e) => `${e.shotId}（${e.reason}）`).join("；")}`
      },
      {
        id: "material-segments", pass: materialReady, hard: true,
        detail: materialReady
          ? `${materialShots().filter(requiresGeneration).length} 个素材镜已产出且过 G-MAT1（生成溯源 + 非静态直出 + 保真评审）`
          : `有素材镜未产出或未过 G-MAT1（素材只作生成输入，禁止静态直出）`
      },
      /**
       * 环境真实性（2026-09-27 事故机制化）：G7 是"花钱之前最后一道门"，
       * 环境审计的结论必须在这道门的**判据清单**里可见（而不是只写在控制台日志里）——
       * 平台执行器与审计器按 step_key 读的是 checks[]，环境真实性缺了这一条就又会变成"只有人眼能发现"。
       */
      {
        id: "env-realism", pass: envHardTotal === 0 || envAccepted, hard: true,
        detail: envHardTotal === 0
          ? `环境真实性 + 设备口径硬缺陷 0（场景圣经 ${sceneBible ? sceneBible.spaceId : "未提供"}；设备清单 ${DEVICE_POLICY_VERSION}；软提示 ${envSoftTotal} 项，报告 ${basename(ENV_REPORT_FILE)}）`
          : `环境真实性硬缺陷 ${envSummary.hard} 项 + 设备口径硬缺陷 ${devSummary.hard} 项（${Object.entries({ ...envSummary.byRule, ...devSummary.byRule }).map(([rule, count]) => `${rule}×${count}`).join(" · ")}）${envAccepted ? "——已显式声明带瑕疵放行" : "——渲染前必须清零"}`
      },
      {
        /**
         * 片型配比（景别/机位/叙事证据）是**创作口径**（T-2026-0930-0014 产品所有者口径）：
         * 默认降为咨询项（不挡花钱前的放行）；需要旧口径时用 `--review-policy blocking`。
         */
        id: "scene-policy", pass: scenePolicyReport?.passed ?? true, hard: REVIEW_POLICY === "blocking",
        detail: scenePolicyReport
          ? `${scenePolicy!.id}@${scenePolicy!.version} 全片配比和逐镜品质门：${scenePolicyReport.defects.length} 项缺陷`
            + `（按 T-2026-0930-0014 口径默认记为咨询项${REVIEW_POLICY === "blocking" ? "；--review-policy blocking 下仍作硬闸" : ""}）；`
            + `报告 ${basename(SCENE_POLICY_REPORT_FILE)}`
          : "需求未命中已安装的片型知识条目（本门不适用）"
      },
      /** 平台语速门（2026-09-30）：与 hook-first-3s 同口径，结论必须在这道花钱前的门里可见 */
      {
        id: "speech-rate", pass: speechOver.length === 0 || speechAccepted, hard: true,
        detail: speechOver.length === 0
          ? `${PLATFORM} ${speechProfile.tier} 档（${speechProfile.target}–${speechProfile.max} 字/秒）：${speechMeasured.length} 个台词镜全部念得完${speechLoose.length > 0 ? `；节奏偏松 ${speechLoose.length} 项（软提示）` : ""}`
          : `${speechOver.length} 个台词镜念不完：${speechOver.map((row) => row.shotId).join("、")}（配音阶段才发现会毁掉节奏与对齐）${speechAccepted ? "——已显式声明带瑕疵放行" : "——必须改写文案或加长该镜"}`
      },
      /** 开场钩子（2026-09-27 新增岗位/机制）：同 env-realism，结论必须在这道花钱前的门里可见 */
      {
        id: "hook-first-3s", pass: hookSummary.hard === 0 || hookAccepted, hard: true,
        detail: hookSummary.hard === 0
          ? `开场钩子硬失败 0（${hookCard ? `${hookCard.type}｜兑现镜 ${hookCard.payoffShotId}` : "未登记钩子卡"}；平台 ${PLATFORM} 窗口前 ${hookWindowFor(PLATFORM)}s；软提示 ${hookSummary.soft} 项）`
          : `开场钩子硬失败 ${hookSummary.hard} 项（${hookSummary.hardFailures.map((check) => check.id).join("、")}）${hookAccepted ? "——已显式声明带瑕疵放行" : "——渲染前必须清零"}`
      },
      { id: "micromotion-applied", pass: micromotionReady, hard: true,
        detail: !STAGES.has("micromotion") ? "本轮未启用微动作增强，不声明已执行"
          : micromotionReady ? "已逐镜复核当前卡片的适用性、原始意图与实际写入哈希（含合法不适用）"
            : micromotionEvidence.filter((entry) => !entry.verified).map((entry) => `${entry.shotId}：${entry.detail}`).join("；") }
    ],
    evidence: {
      promptReady, plateReady, promptApproved, plateApproved, materialReady, micromotionReady, micromotionEvidence,
      envRealism: { hard: envSummary.hard, soft: envSummary.soft, byRule: envSummary.byRule, bible: sceneBible?.spaceId ?? null, report: ENV_REPORT_FILE },
      scenePolicy: scenePolicyReport ? { id: scenePolicy!.id, version: scenePolicy!.version, sourceSha256: scenePolicy!.sourceSha256,
        ratios: scenePolicyReport.ratios, exceptionsApplied: scenePolicyReport.exceptionsApplied, report: SCENE_POLICY_REPORT_FILE } : null,
      devicePolicy: { version: DEVICE_POLICY_VERSION, hard: devSummary.hard, soft: devSummary.soft, byRule: devSummary.byRule },
      openingHook: {
        platform: PLATFORM, windowSec: hookWindowFor(PLATFORM), hard: hookSummary.hard, soft: hookSummary.soft,
        hook: hookCard ? { type: hookCard.type, promise: hookCard.promise, payoffShotId: hookCard.payoffShotId } : null,
        sfx: hookSfxEnabled ? hookSfxSpec : null
      }
    }
  });
  if (!g7.approved && !ACCEPT_REJECTED.includes("G7")) {
    log(`⛔ G7 预生产最终确认未通过：${g7.reason}`);
    process.exit(5);
  }

  }

  /**
   * 参考图口径（`docs/character-archive-design.md` 附录 A.2）：**默认不往每镜塞定妆照**。
   * 真机复验：影棚灰底定妆照当参考图会把"美颜 + 柔光箱"的风格带进成片
   * （细节 58.6 vs 实景帧 1204.2、饱和 0.369 vs 0.205）。人物一致性改由 **首帧 = 该镜关键帧** 承担
   * （关键帧本身已用定妆照锚定过长相）；确需额外锚定时用 `--use-portrait-refs` 显式打开。
   */
  const usePortraitRefs = flag("--use-portrait-refs");
  const refs = usePortraitRefs && lead
    ? (["front", "closeup"].map((a) => lead.files[a]).filter(Boolean) as string[])
    : [];
  /**
   * 授权真人素材镜的参考图口径（T-2026-0929-0003）：
   * 该镜**只**带平台授权素材引用（`asset://<asset ID>`）作 `reference_image`，且**不带首帧**——
   * 首帧会给一张 AI 生成的脸，把真人身份顶掉。人物身份、口型与台词都交给 Seedance 按参考图生成。
   */
  /**
   * 真人镜参考图：**主素材 + 同组素材（最多 3 张）**——单张参考容易漂脸，同组多张显著更稳。
   * 资质与授权范围来自真人主档（referenceAssets / assetGroupId）。
   */
  /**
   * 真人镜参考图：**同组多张素材（最多 3）+ 首镜已放行帧（身份锚）**，总计不超过 4 张。
   * 侧脸/背影等非正面构图靠这套锚定保长相——不靠删构图。
   */
  const refsForShot = (shot: ShotCard): string[] => {
    if (!isAssetShot(shot)) return refs;
    const id = assetIdOf(assetRefOf(shot));
    const entry = realPersonLibrary.byAssetId.get(id);
    const base = entry ? referenceAssetRefs(entry.asset, 3) : [assetRefOf(shot)];
    return base;
  };
  /**
   * 送审基准图口径：评审组件按**本地文件**读图，`asset://` 是平台素材引用、不是文件路径
   * （真机 2026-09-29：把 asset 引用当基准图投递 → `ENOENT: open 'asset://…'`，监制直接不可用）。
   * 因此送审时只投递本地存在的图片；授权素材引用只进生成请求（`arkVideo` 的 reference_image）。
   */
  const localReviewRefs = localReviewRefsEarly;
  for (const shot of FIRST_PASS_ORDER) {
    if (acceptExistingRenderedClip(shot)) continue;
    const clip = productionClipFile(shot.shotId);
    const duration = Number(shot.duration ?? 5);
    /**
     * 素材镜：片段已在 `material-gen` 阶段生成并过 G-MAT1（生成溯源 + 非静态直出 + 保真评审），
     * 这里不再走"生成镜复检/提交审批"（判据不同），但**必须**确认 G-MAT1 的 verify 事件在场。
     */
    if (isMaterialShot(shot)) {
      const verified = acceptExistingRenderedClip(shot);
      record({
        stage: "shot", shotId: shot.shotId, invoked: false, ok: existsSync(clip) && verified, cached: true,
        degraded: !verified, attempt: 0, ms: 0,
        artifact: existsSync(clip) ? clip : null,
        evidence: {
          photo: String((shot as Record<string, unknown>).photo), source: "material-gen",
          materialGate: verified ? "G-MAT1 verify 事件在场" : "缺 G-MAT1 verify 事件",
          policy: MATERIAL_POLICY_VERSION, skipReason: "素材镜的生成与判据在 material-gen 阶段完成"
        },
        verdict: null,
        note: verified
          ? "素材镜：生成产物已过 G-MAT1（复用，不重复提交渲染）"
          : "素材镜：缺 G-MAT1 verify 事件（素材是否被当镜头用无法证明）"
      });
      continue;
    }
    const shotRefs = refsForShot(shot);
    const shotIsAsset = isAssetShot(shot);
    rememberInputs(
      "shot",
      shotIsAsset
        ? [join(PROMPT_DIR, `${shot.shotId}.txt`), assetRefOf(shot)]
        : [join(PROMPT_DIR, `${shot.shotId}.txt`), join(PLATE_DIR, `${shot.shotId}-plate.png`), ...shotRefs],
      shot.shotId
    );
    if (acceptExistingRenderedClip(shot)) continue;
    if (DRY_RUN) {
      record({ stage: "shot", shotId: shot.shotId, invoked: false, ok: true, cached: false, degraded: false, attempt: 0, ms: 0, artifact: null, evidence: { dryRun: true }, verdict: null });
      continue;
    }
    const plate = join(PLATE_DIR, `${shot.shotId}-plate.png`);
    const prompt = readFileSync(join(PROMPT_DIR, `${shot.shotId}.txt`), "utf8")
      + (REVISION_CONTEXT ? `\n\n【本次返修验收】保持原镜头主体与意图，仅修复下列已归因问题：${REVISION_CONTEXT}` : "");
    let approved = false;
    /**
     * 重试必须「带变更」（2026-09-24 烧额度根因）：
     * 早先第 2 次尝试提交的是**与第 1 次完全相同的提示词**（只有 seed 不同），
     * 本质是"重采样碰运气"而不是修问题——SC-02 因此连烧 5 次渲染仍不过。
     * 现在把上一轮监制的 issues/suggestions 显式写进提示词，并记录提示词指纹，
     * 让日志能自证"这次重试确实改了东西"。
     */
    let lastVerdict: ProducerVerdict | null = null;
    let lastPromptFingerprint: string | null = null;
    for (let attempt = 1; attempt <= 1 && !approved; attempt += 1) {
      const started = Date.now();
      const attemptPrompt = attempt === 1 ? prompt : `${prompt}\n\n${retryInstruction(lastVerdict, attempt, MAX_ATTEMPTS)}`;
      const promptFingerprint = createHash("sha256").update(attemptPrompt).digest("hex").slice(0, 12);
      try {
        /**
         * 首帧必须用**Ark 托管 URL**（同账号模型产物），不能是 base64：
         * 真机实测 base64 真人图会被隐私校验拒（见 `hostedUrlFile` 注释与探针脚本）。
         * 托管 URL 过期（>20h）时退回 base64 并如实记录——让监制看到这是降级路径，而不是假装成功。
         */
        /**
         * 授权真人素材镜（T-2026-0929-0003）：**不要首帧**。
         * 首帧是一张 AI 生成的人脸，会把平台素材里的真人身份顶掉（Seedance 以首帧为画面基准）；
         * 这类镜头改由 `reference_image = asset://<asset ID>` 承担人物身份，让模型按真实长相生成。
         */
        const hosted = shotIsAsset ? null : loadHostedUrl(shot.shotId);
        const firstFrame = shotIsAsset ? undefined : hosted ?? (existsSync(plate) ? dataUrl(plate) : undefined);
        if (!shotIsAsset && !hosted && existsSync(plate)) {
          log(`  ⚠ ${shot.shotId} 无有效托管 URL，退回 base64 首帧（真人题材大概率被隐私校验拒）`);
        }
        /**
         * G8 渲染提交审批（step_key: g8-render-submit）——**花钱之前**的逐镜门。
         *
         * 与 §⑤ 的 `shot` 门（生成之后再评审）不同，G8 管的是"这一单该不该提交"：
         * 提示词是否达到交付口径、有没有把 f 值等技术参数写进正文（KB 纪律）、画幅约束是否在场、
         * 首帧锚点是否存在、以及本镜是否在知情放行名单里。不通过就不提交（不烧额度）。
         */
        const promptText = readFileSync(join(PROMPT_DIR, `${shot.shotId}.txt`), "utf8");
        const g8 = recordGate({
          stepKey: "g8-render-submit",
          sourceStage: "shot",
          shotIds: [shot.shotId],
          checks: [
            { id: "prompt-length", pass: promptText.trim().length >= 1200, hard: true, detail: `提示词 ${promptText.trim().length} 字（交付口径 ≥1200）` },
            { id: "no-hard-params", pass: !/f\/\d/.test(promptText), hard: true, detail: /f\/\d/.test(promptText) ? "提示词正文出现 f 值（KB 纪律：正文只写画面语言，f 值只进 trace）" : "正文不含 f 值等技术参数" },
            { id: "aspect-constraint", pass: /【约束】/.test(promptText) && promptText.includes(ASPECT), hard: true, detail: `含【约束】与画幅 ${ASPECT}` },
            { id: "duration-limit", pass: duration > 0 && duration <= 30, hard: true, detail: `单镜时长 ${duration}s（上限 30s）` },
            {
              id: "first-frame", pass: shotIsAsset ? true : Boolean(hosted) || existsSync(plate), hard: true,
              detail: shotIsAsset
                ? `授权真人素材镜：不带首帧，人物身份由参考图 ${assetRefOf(shot)} 承担（外部素材 ID，未平台核验）`
                : hosted ? `首帧用 Ark 托管 URL（${basename(hosted)}）` : existsSync(plate) ? "首帧退回本地关键帧 base64（隐私校验风险，已记录）" : "既无托管 URL 也无关键帧"
            },
            {
              id: "plate-size", pass: shotIsAsset || !existsSync(plate) || statSync(plate).size > 50_000, hard: false,
              detail: shotIsAsset ? "授权真人素材镜不产关键帧（合规口径，不是缺件）" : existsSync(plate) ? `关键帧 ${(statSync(plate).size / 1024).toFixed(0)}KB` : "无关键帧文件"
            }
          ],
          evidence: {
            model: VIDEO_MODEL, seconds: duration, attempt,
            promptFingerprint: createHash("sha256").update(attemptPrompt).digest("hex").slice(0, 12),
            promptChars: promptText.trim().length
          }
        });
        if (!g8.approved && !ACCEPT_REJECTED.includes(shot.shotId) && !ACCEPT_REJECTED.includes("G8")) {
          log(`  ⏭ ${shot.shotId} G8 未批准提交（${g8.reason.slice(0, 120)}）→ 不提交，避免白烧额度`);
          record({
            stage: "shot", shotId: shot.shotId, invoked: false, ok: false, cached: false, degraded: false, attempt,
            ms: Date.now() - started, artifact: null, evidence: { gateBlocked: "g8-render-submit", reason: g8.reason }, verdict: null,
            note: "G8 渲染提交审批未通过：未向渲染服务提交"
          });
          break;
        }
        preflightSubmitGuard({ shotId: String(shot.shotId), stage: "videos", prompt: attemptPrompt, fps: FPS, attempt, prevFingerprint: lastPromptFingerprint });
        lastPromptFingerprint = promptFingerprint;
        const submitted = await arkVideo({
          stage: "videos", shotId: shot.shotId, target: join(CLIP_DIR, `${shot.shotId}.raw.mp4`),
          prompt: attemptPrompt,
          firstFrame,
          refs: shotRefs.map(dataUrl),
          /** 模型时长能力在提交前核对；已渲染镜头完整保留原速 */
          seconds: renderSecondsFor(duration),
          generateAudio: ENV.SEEDANCE_GENERATE_AUDIO !== "0",
          seed: 20260924 + attempt
        });
        const rawClip = join(CLIP_DIR, `${shot.shotId}.raw.mp4`);
        await download(submitted.url, rawClip);
        recordProviderSource(shot, rawClip, submitted.taskId, false);
        rememberInputs("shot", [rawClip], shot.shotId);
        copyFileSync(rawClip, clip);
        const normalized = { factor: 1, from: inspectPostInput({ file: rawClip, ffprobe: FFPROBE }).durationSec,
          to: inspectPostInput({ file: clip, ffprobe: FFPROBE }).durationSec, sourceTiming: "preserved" };
        const technical = inspectPostInput({ file: clip, ffprobe: FFPROBE });
        const verdict = postAcceptanceVerdict({ stage: "shot", receipts: [technical] });
        record({ stage: "shot", shotId: shot.shotId, invoked: true, ok: true, cached: false, degraded: false,
          attempt, ms: Date.now() - started, artifact: clip,
          evidence: { ...technical, taskId: submitted.taskId, raw: rawClip, outputFiles: [rawClip], normalized,
            promptVariant: "base", promptFingerprint, qualityReviewed: false, policy: POST_RENDER_ACCEPTANCE_POLICY }, verdict });
        approved = true;
      } catch (err) {
        record({
          stage: "shot", shotId: shot.shotId, invoked: true, ok: false, cached: false, degraded: false, attempt,
          ms: Date.now() - started, artifact: null, evidence: { error: err instanceof Error ? err.message.slice(0, 300) : String(err) }, verdict: null
        });
        throw err;
      }
    }
    if (!approved) throw new Error(`RENDER_SUBMIT_BLOCKED: ${shot.shotId} 未获花钱前授权`);
  }
}

/* ---------- ③-2 原声接受 / 明确请求的统一配音 ---------- */
const NARRATION_PROFILE = arg("--narration-profile", "zh-xiaozhi");
const UNIFIED_NARRATION = flag("--narration-unified") || flag("--unified-narration");
function voicedFile(shotId: string): string { return join(CLIP_DIR, `${shotId}.voiced.mp4`); }
function latestVoiceRecord(shotId: string): StageRecord | null {
  return readStageHistory().filter(entry => entry.stage === "voice" && entry.shotId === shotId && entry.evidence?.projectId === PROJECT).at(-1) ?? null;
}
function clipFor(shot: ShotCard): string {
  const raw = productionClipFile(shot.shotId);
  if (!UNIFIED_NARRATION) return raw;
  const voiced = voicedFile(shot.shotId);
  const status = assessVoiceArtifact({ record: latestVoiceRecord(shot.shotId), projectId: PROJECT, shotId: shot.shotId,
    raw, voiced, text: dialogueText(shot), profile: NARRATION_PROFILE });
  return status.ok && status.voiced && artifactReusable("voice", voiced, raw, shot.shotId) ? voiced : raw;
}
const narrationCoverage: Array<{ shotId: string; speaker: string; text: string; ok: boolean; source: string; detail: string }> = [];
if (!DRY_RUN && ["voice", "compose"].some(stage => STAGES.has(stage))) for (const shot of shots) {
  if (cachedProviderSources.has(shot.shotId)) acceptExistingRenderedClip(shot);
}
if (STAGES.has("voice") && !DRY_RUN) {
  for (const shot of shots) {
    const started = Date.now(), raw = productionClipFile(shot.shotId), text = dialogueText(shot);
    try {
      const technical = inspectPostInput({ file: raw, ffprobe: FFPROBE });
      const provenance = { projectId: PROJECT, rawSha256: technical.sha256, textSha256: fingerprintText(text) };
      rememberInputs("voice", [raw], shot.shotId);
      let artifact = raw, source = "provider-source-accepted", voicedSha256: string | null = null;
      if (UNIFIED_NARRATION && text) {
        if (!existsSync(VOICE_CLI)) throw new Error("VOICE_TOOL_MISSING: 明确配音请求缺正式语音工位");
        const out = voicedFile(shot.shotId), candidate = `${out}.pending-${randomUUID()}.mp4`;
        const dub = WORKER_RUNTIME ? await WORKER_RUNTIME.dub(raw, candidate, text, NARRATION_PROFILE, "replace-bed", shot.shotId)
          : runCli(VOICE_CLI, ["dub", "--in", raw, "--out", candidate, "--profile", NARRATION_PROFILE,
            "--text", text, "--policy", "replace-bed", "--lufs", "-16"]);
        let candidateOk = false;
        try { if (dub.ok) { inspectPostInput({ file: candidate, ffprobe: FFPROBE }); candidateOk = fingerprintFile(raw) === provenance.rawSha256; } }
        catch (error) { rmSync(candidate, { force: true }); throw error; }
        const promoted = promoteDubCandidate({ candidate, final: out, commandOk: dub.ok, verifiedOk: candidateOk });
        if (!promoted.ok) throw new Error(`VOICE_POST_FAILED: ${promoted.reason}: ${dub.out.slice(-300)}`);
        artifact = out; source = "tts-narration"; voicedSha256 = fingerprintFile(out);
      }
      record({ stage: "voice", shotId: shot.shotId, invoked: UNIFIED_NARRATION && Boolean(text), ok: true,
        cached: !UNIFIED_NARRATION, degraded: false, attempt: 1, ms: Date.now() - started, artifact,
        evidence: { ...provenance, source, profile: NARRATION_PROFILE, voicedSha256, qualityReviewed: false,
          policy: POST_RENDER_ACCEPTANCE_POLICY, narrationExplicitlyRequested: UNIFIED_NARRATION, dialogue: Boolean(text) }, verdict: null,
        note: UNIFIED_NARRATION && text ? "执行明确请求的统一配音；未做ASR、对白、口型或音质评审"
          : "供应商原声或静音默认接受；不核查、不补配音、不改写台词" });
    } catch (error) {
      record({ stage: "voice", shotId: shot.shotId, invoked: UNIFIED_NARRATION, ok: false, cached: false, degraded: false,
        attempt: 1, ms: Date.now() - started, artifact: null,
        evidence: { error: error instanceof Error ? error.message : String(error) }, verdict: null });
      throw error;
    }
  }
}

/* ---------- ④ 合成母版 ---------- */
let master = join(POST_DIR, "master-raw.mp4");
if (STAGES.has("compose") && DRY_RUN) {
  log("dry-run：跳过合成与本地逐镜增强，不产出可误认作正式 UHD 的视频");
}
if (STAGES.has("compose") && !DRY_RUN) {
  const blocked = shots.filter(shot => !acceptExistingRenderedClip(shot)).map(shot => shot.shotId);
  rememberInputs("compose", [...shots.map(clipFor), ...(END_CARD_IMAGE ? [END_CARD_IMAGE] : [])]);
  const started = Date.now();
  /**
   * 镜头顺序不变量（2026-09-26）：成片顺序默认必须**等于分镜顺序**——
   * 镜头之间有内容逻辑顺序，后期不许为卡点/情绪重排；素材来自媒资库时走 reuse-assembly 并给依据。
   * 这里把"顺序"做成显式判据 + 阶段证据，未来任何"排在前面/后面"的改动都会被这一关拦下。
   */
  const storyboardOrder = shots.map((s) => s.shotId);
  const requestedOrder = COMPOSE_ORDER
    ? COMPOSE_ORDER.split(",").map((value) => value.trim()).filter(Boolean)
    : storyboardOrder;
  const clipById = new Map(shots.map((s) => [s.shotId, clipFor(s)]));
  const orderCheck = checkShotOrder(storyboardOrder, requestedOrder, ORDER_POLICY, { reusePlan: REUSE_PLAN });
  if (!orderCheck.ok) {
    log(`⛔ 镜头顺序判据不通过：${orderCheck.detail}`);
    record({
      stage: "compose-order", shotId: null, invoked: true, ok: false, cached: false, degraded: false, attempt: 1, ms: 0,
      artifact: null,
      evidence: { policy: ORDER_POLICY, expected: orderCheck.expected, actual: orderCheck.actual, firstDivergence: orderCheck.firstDivergence },
      verdict: null, note: "后期不得重排镜头（内容逻辑顺序）；确需重排请走 --order-policy reuse-assembly + --reuse-plan"
    });
  } else if (ORDER_POLICY === "reuse-assembly") {
    log(`↻ 镜头顺序：媒资库复用路径（reuse-assembly）—— ${orderCheck.detail}`);
  }
  /** 合成用片段：优先取配音版（旁白已混入），原始片段保持只读 */
  const clips = orderCheck.ok
    ? requestedOrder.map((shotId) => clipById.get(shotId)!).filter(Boolean)
    : [];
  const missing = clips.filter((c) => !existsSync(c));
  // Existing paid clips may have failed old quality reviews. Rebind their current source bytes,
  // while keeping the historical rows untouched. External post-only inputs retain their declaration.
  if (blocked.length && POST_ONLY_ASSEMBLY) {
    postOnlyMissingReceipts = [...blocked];
    recordGate({
      stepKey: "g-post-only-assembly",
      sourceStage: "compose",
      checks: [{
        id: "post-only-declared", pass: true, hard: false,
        detail: `post-only 组装：${blocked.length} 镜无本片 shot/voice 回执（${blocked.join("、")}）；原因：${POST_ONLY_REASON}`
      }],
      shotIds: blocked,
      degraded: true,
      reason: "post-only 组装（degraded）：源镜头为外部成品片段，缺本片回执",
      evidence: { assemblyMode: "post-only", reason: POST_ONLY_REASON, blocked }
    });
    log(`⚠ post-only 组装模式：${blocked.length} 镜无本片回执（已落 degraded 门记录）→ 继续走完整后期链`);
  } else if (blocked.length) log(`⛔ 缺少当前镜头或人声的通过回执，合成中止：${blocked.join("、")}`);
  /** post-only 组装：回执缺失（blocked）不阻断合成；顺序错误或缺片仍然阻断（那是事实性缺陷，不是"没回执"） */
  const receiptsBlock = blocked.length > 0 && !POST_ONLY_ASSEMBLY;
  if (!orderCheck.ok || missing.length > 0 || receiptsBlock) {
    record({ stage: "compose", shotId: null, invoked: false, ok: false, cached: false, degraded: false, attempt: 1, ms: 0, artifact: null,
      evidence: { orderOk: orderCheck.ok, missing, blocked }, verdict: null, note: "镜头顺序、镜头产物或人声未过门，跳过合成" });
    throw new Error(`COMPOSE_INPUT_FAILED: 镜头顺序 ${orderCheck.ok ? "通过" : "失败"}、缺片 ${missing.length}、来源回执缺失 ${blocked.length}`);
  } else {
    const { width: w, height: h } = OUTPUT_SIZE;
    /**
     * 默认按请求画布执行 FFmpeg 缩放/补边，不要求源片 AI 增强。
     * 只有明确提供增强引擎或 --enhance 时才逐镜运行该加工，核对实际引擎、源/产物摘要与导出轨道。
     * 云端生成阶段始终使用 SOURCE_RESOLUTION，不因交付档切成付费 4K 请求。
     */
    const composeClips = [...clips];
    const enhancementEvidence: string[] = [];
    if (ENHANCE_ENGINE_DIR || flag("--enhance")) {
      const engineFile = join(REPO_ROOT, "bundles/ai-video/connectors/enhance-bridge/core.mjs");
      if (!existsSync(engineFile)) throw new Error(`UHD 本地增强引擎不存在：${engineFile}`);
      const enhancer = await import(engineFile) as {
        enhanceVideo: (input: {
          input: string; outputDir: string; scopeId: string; targetWidth: number; targetHeight: number;
          kind: "live-action" | "animation"; engineDir?: string; bins: { ffmpeg: string; ffprobe: string };
        }) => Promise<{
          output: string; sha256: string; sourceSha256: string; key: string; reused: boolean;
          provenancePath: string; processingMode: string; model: string | null; modelScale: number | null;
          engine: Record<string, unknown>; receipt: { localVerified?: boolean };
        }>;
      };
      const enhancedDir = join(WORK_DIR, "enhanced", PROJECT, "2160p");
      mkdirSync(enhancedDir, { recursive: true });
      for (const [index, source] of clips.entries()) {
        const shotId = requestedOrder[index]!;
        const startedEnhancement = Date.now();
        const sourceInfo = probe(source);
        const card = shots.find((shot) => shot.shotId === shotId) as (ShotCard & { enhancementKind?: string }) | undefined;
        const requestedKind = card?.enhancementKind ?? ENHANCE_KIND;
        try {
          rememberInputs("enhance", [source], shotId);
          if (!["live-action", "animation"].includes(requestedKind)) {
            throw new Error(`镜头 ${shotId} enhancementKind=${requestedKind} 不适合 AI 超分；文字/图形镜头须原生 4K 渲染`);
          }
          const kind = requestedKind as "live-action" | "animation";
          const enhanced = await enhancer.enhanceVideo({
            input: source,
            outputDir: enhancedDir,
            scopeId: `film-${createHash("sha256").update(`${PROJECT}:${shotId}`).digest("hex").slice(0, 16)}`,
            targetWidth: w,
            targetHeight: h,
            kind,
            bins: {
              ffmpeg: process.env.WORKLOOM_ENHANCE_FFMPEG_PATH || FFMPEG,
              ffprobe: process.env.WORKLOOM_ENHANCE_FFPROBE_PATH || FFPROBE
            },
            ...(ENHANCE_ENGINE_DIR ? { engineDir: abs(ENHANCE_ENGINE_DIR) } : {})
          });
          if (enhanced.receipt?.localVerified !== true || !existsSync(enhanced.output) || !existsSync(enhanced.provenancePath)) {
            throw new Error("缺本地增强回执、产物或溯源文件");
          }
          if (fingerprintArtifact(source).sha256 !== enhanced.sourceSha256
            || fingerprintArtifact(enhanced.output).sha256 !== enhanced.sha256) {
            throw new Error("增强回执的源片或产物 SHA-256 与当前字节不一致");
          }
          const sourceWidth = Number(sourceInfo.width ?? 0);
          const sourceHeight = Number(sourceInfo.height ?? 0);
          const sourceBelowTarget = sourceWidth < w || sourceHeight < h;
          const aiProvenanceOk = enhanced.processingMode === "ai-upscale"
            && Boolean(enhanced.model)
            && /^[a-f0-9]{64}$/i.test(String(enhanced.engine?.archiveSha256 ?? ""));
          if (sourceBelowTarget && !aiProvenanceOk) {
            throw new Error(`低于 UHD 目标的镜头必须有本地 AI 超分模型与引擎指纹：`
              + `${sourceWidth}x${sourceHeight} → ${w}x${h}，实际 ${enhanced.processingMode}`);
          }
          if (!sourceBelowTarget && !aiProvenanceOk
            && !["passthrough", "native-resize"].includes(enhanced.processingMode)) {
            throw new Error(`UHD 原生/缩小镜头处理模式不可信：${enhanced.processingMode}`);
          }
          const outputInfo = probe(enhanced.output);
          const durationDrift = Math.abs(Number(outputInfo.duration ?? 0) - Number(sourceInfo.duration ?? 0));
          const dimensionsOk = Number(outputInfo.width) === w && Number(outputInfo.height) === h;
          const audioOk = !sourceInfo.hasAudio || Boolean(outputInfo.hasAudio);
          if (!dimensionsOk || durationDrift > 0.15 || !audioOk) {
            throw new Error(`增强产物机检未过：${outputInfo.width}x${outputInfo.height}（目标 ${w}x${h}）`
              + `、时长漂移 ${durationDrift.toFixed(3)}s、音轨 ${audioOk ? "保留" : "丢失"}`);
          }
          composeClips[index] = enhanced.output;
          enhancementEvidence.push(enhanced.provenancePath);
          record({
            stage: "enhance", shotId, invoked: true, ok: true, cached: enhanced.reused, degraded: false,
            attempt: 1, ms: Date.now() - startedEnhancement, artifact: enhanced.output,
            evidence: {
              quality: QUALITY, kind, source, sourceSha256: enhanced.sourceSha256,
              outputSha256: enhanced.sha256, key: enhanced.key, provenancePath: enhanced.provenancePath,
              processingMode: enhanced.processingMode, model: enhanced.model, modelScale: enhanced.modelScale,
              engine: enhanced.engine,
              sourceProbe: sourceInfo, outputProbe: outputInfo, durationDriftSec: Number(durationDrift.toFixed(3)),
              localVerified: true, outputFiles: [enhanced.provenancePath]
            }, verdict: null,
            note: "本机逐镜增强回执已核验；不代表媒体库版本链或额度台账已同步"
          });
          if (!artifactReusable("enhance", enhanced.output, source, shotId)) {
            throw new Error(`镜头 ${shotId} 增强后的当前产物缺通过回执`);
          }
        } catch (error) {
          record({
            stage: "enhance", shotId, invoked: true, ok: false, cached: false, degraded: false,
            attempt: 1, ms: Date.now() - startedEnhancement, artifact: null,
            evidence: { source, target: `${w}x${h}`, error: error instanceof Error ? error.message : String(error) },
            verdict: null, note: "UHD 增强失败，正式交付中止"
          });
          throw error;
        }
      }
      // The compose receipt must bind the exact enhanced bytes and provenance it consumed.
      rememberInputs("compose", [...clips, ...composeClips, ...enhancementEvidence]);
    }
    const result = runCli(join(REPO_ROOT, "scripts/tools/compose-film.mts"), [
      "--clips", composeClips.join(","), "--out", master, "--width", String(w), "--height", String(h),
      "--shot-ids", requestedOrder.join(","),
      "--fps", String(FPS), "--fade", String(XFADE), "--color", "none",
      "--clip-tail-holds", requestedOrder.map((id) => COMPOSE_HOLDS_BY_SHOT.get(id) ?? 0).join(","),
      /**
       * 逐刀转场（2026-09-25）：`--cut-transition` 指定 xfade 名（默认硬切；重叠转场在输出前拒绝）、
       * `--cut-transition-duration` 指定秒数（默认 0.18）。传空字符串 = 纯硬切。
       */
      ...(EFFECTIVE_CUT_TRANSITION ? ["--transition", EFFECTIVE_CUT_TRANSITION, "--transition-duration", String(CUT_TRANSITION_DURATION)] : [])
      , ...(EFFECTIVE_CUT_TRANSITION && EFFECTIVE_CUT_TRANSITION_AT ? ["--transition-at", EFFECTIVE_CUT_TRANSITION_AT] : [])
      /** 独立结尾卡增加自己的时间段，不改变任何源镜头。 */
      , ...(END_CARD_IMAGE ? ["--end-card-image", END_CARD_IMAGE, "--end-card-seconds", String(END_CARD_SECONDS)] : [])
      /**
       * 保留旧调用参数兼容性；当前合成不做 PCM 对齐、声学或源片品质二次放行。
       */
      , ...(flag("--accept-av-sync-drift") ? ["--accept-av-sync-drift"] : [])
    ]);
    const info = existsSync(master) ? probe(master) : {};
    const verdict = result.ok ? await reviewStage({
      stage: "compose", projectId: PROJECT,
      artifacts: [{ path: master, kind: "video", probe: info }],
      deterministic: [
        { id: "exists", pass: existsSync(master), detail: existsSync(master) ? "母版已生成" : "母版不存在", hard: true },
        {
          /** 只核对实际导出有可读的正时长；请求目标不驱动源镜头变速。 */
          id: "duration",
          pass: Number(info.duration ?? 0) > 0,
          detail: `实际 ${Number(info.duration ?? 0).toFixed(3)}s；创作目标 ${totalSeconds}s仅作观测，源镜头原速完整保留`,
          hard: true
        },
        { id: "resolution", pass: Number(info.width) === w && Number(info.height) === h, detail: `${info.width}x${info.height}` , hard: true }
      ],
      context: {
        clips: clips.length,
        /** 创作目标作为观测记录，源表演完整保留。 */
        durationPolicy: FILM_COMPLETENESS_PRINCIPLE,
        transitions: EFFECTIVE_CUT_TRANSITION ? { name: EFFECTIVE_CUT_TRANSITION, durationSec: CUT_TRANSITION_DURATION, at: EFFECTIVE_CUT_TRANSITION_AT } : null
      }, env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
    }) : null;
    record({
      stage: "compose", shotId: null, invoked: true, ok: Boolean(result.ok && verdict?.approved), cached: false,
      degraded: Boolean(verdict?.degraded), attempt: 1, ms: Date.now() - started, artifact: master,
      evidence: {
        ...info, outputFiles: [`${master.replace(/\.mp4$/i, "")}.compose-receipt.json`], tool: "scripts/tools/compose-film.mts",
        quality: QUALITY, sourceResolution: SOURCE_RESOLUTION, outputResolution: OUTPUT_RESOLUTION,
        enhancedClips: enhancementEvidence.length ? composeClips : [],
        processingMode: enhancementEvidence.length ? "explicit-local-enhancement" : "requested-ffmpeg-scale-pad",
        /** 顺序判据证据（policy/期望顺序/实际顺序），终审与审计都能按它复核"有没有打乱镜头" */
        order: { policy: ORDER_POLICY, expected: orderCheck.expected, actual: orderCheck.actual, ok: orderCheck.ok },
        tailHolds: requestedOrder.map(id => ({ shotId: id, seconds: COMPOSE_HOLDS_BY_SHOT.get(id) ?? 0 })),
        editorial: { excludedShotIds: sourceIds.filter(id => !editorialIds.includes(id)), reason: POST_ONLY_REASON,
          sourceTiming: "preserved", independentEndCard: END_CARD_IMAGE ? { path: END_CARD_IMAGE, seconds: END_CARD_SECONDS } : null },
        qualityReviewed: false,
      }, verdict
    });
    if (!result.ok || !verdict?.approved) {
      throw new Error(`COMPOSE_POST_FAILED: ${result.ok ? verdict?.reason ?? "导出技术未通过" : result.out.slice(-400)}`);
    }
  }
}

// Post layers use compose's actual complete-source timeline; planned duration never drives a retime.
if (!DRY_RUN && existsSync(master)) {
  const timelineFile = master.replace(/\.mp4$/i, ".compose-receipt.json");
  const timing = JSON.parse(readFileSync(timelineFile, "utf8")) as {
    output?: { sha256?: string }; normalizedTimeline?: Array<{ shotId?: string; path: string; sha256: string; composedSeconds: number; speedFactor: number }>;
    independentEndCard?: { composedSeconds?: number } | null;
  };
  if (timing.output?.sha256 !== fingerprintArtifact(master).sha256
    || !timing.normalizedTimeline || timing.normalizedTimeline.length !== shots.length) throw new Error("POST_TIMELINE_UNVERIFIED: exact current compose receipt required");
  const ids = timing.normalizedTimeline.map(row => row.shotId);
  if (new Set(ids).size !== shots.length || ids.some(id => !shots.some(shot => shot.shotId === id))) throw new Error("POST_TIMELINE_SCOPE_CHANGED");
  for (const row of timing.normalizedTimeline) {
    if (row.speedFactor !== 1 || !Number.isFinite(row.composedSeconds) || row.composedSeconds <= 0
      || fingerprintArtifact(row.path).sha256 !== row.sha256) throw new Error("POST_TIMELINE_UNVERIFIED: source timing or bytes changed");
    POST_SECONDS_BY_SHOT.set(row.shotId!, row.composedSeconds);
  }
  POST_SHOT_ORDER = ids as string[];
  expectedMasterSeconds = inspectPostInput({ file: master, ffprobe: FFPROBE }).durationSec;
  const postDurations = postShots().map(postShotSeconds);
  if (END_CARD_SECONDS) {
    const cardSeconds = timing.independentEndCard?.composedSeconds;
    if (!Number.isFinite(cardSeconds) || Number(cardSeconds) <= 0) throw new Error("POST_END_CARD_TIMELINE_UNVERIFIED");
    POST_END_CARD_SECONDS = Number(cardSeconds);
    postDurations.push(POST_END_CARD_SECONDS);
  }
  CUT_GRID = cutTimesFromShots(postDurations, 0, []);
  writeFileSync(join(POST_DIR, "duration-observation.json"), `${JSON.stringify(observeFilmDuration(totalSeconds, expectedMasterSeconds, DURATION_POLICY), null, 2)}\n`);
}

/* ---------- ⑤ 调色（color-bridge 按请求加工一次） ---------- */
/** 未重跑调色时：磁盘上若已有"不早于 raw"的调色版就沿用它（只重跑后段的场景） */
let colored = STAGES.has("color") ? master : preferDownstream(join(POST_DIR, "master-graded.mp4"), master, "color");
if (STAGES.has("color") && existsSync(master)) {
  rememberInputs("color", [master]);
  const started = Date.now();
  const graded = join(POST_DIR, "master-graded.mp4");
  const recipe = arg("--color-recipe", "outdoor-travel");
  /**
   * `grade` 默认执行固定 profile 与强度；显式 `best` 按请求配方执行确定性加工一次。
   * 两者均不读源片画面打分、不循环择优、不按调色可见性或风格品质决定放行。
   */
  const colorMode = arg("--color-mode", "grade");
  const profile = arg("--color-profile", "natural");
  const intensity = arg("--color-intensity", "0.3");
  const result = colorMode === "grade"
    ? runCli(COLOR_CLI, ["grade", "--in", master, "--out", graded, "--profile", profile, "--intensity", intensity])
    : runCli(COLOR_CLI, ["best", "--in", master, "--out", graded, "--recipe", recipe]);
  const produced = existsSync(graded);
  const info = produced ? probe(graded) : probe(master);
  const verdict = await reviewStage({
    stage: "color", projectId: PROJECT,
    artifacts: [{ path: produced ? graded : master, kind: "video", probe: info }],
    deterministic: [
      { id: "grade-produced", pass: produced, detail: produced ? "调色母版已产出" : "请求的调色产物未生成" },
      { id: "color-tool-exit", pass: result.ok, detail: result.ok ? "调色工位退出码 0" : `调色工位失败：${result.out.slice(-200)}`, hard: !result.ok }
    ],
    context: {
      mode: colorMode,
      ...(colorMode === "grade" ? { profile, intensity } : { recipe }),
      toolOutput: result.out.slice(-800)
    },
    env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
  });
  const accepted = result.ok && produced && verdict.approved;
  record({ stage: "color", shotId: null, invoked: true, ok: accepted, cached: false, degraded: false,
    attempt: 1, ms: Date.now() - started, artifact: produced ? graded : null,
    evidence: { mode: colorMode, ...(colorMode === "grade" ? { profile, intensity } : { recipe }),
      tool: `color-bridge ${colorMode}`, qualityReviewed: false }, verdict });
  if (!accepted) throw new Error(`COLOR_POST_FAILED: ${result.out.slice(-400)}; ${verdict.reason}`);
  colored = graded;
}

/* ---------- ⑥ 字幕（subtitle-bridge：选型 + 版式 + 旁挂文件；烧录按需） ---------- */
/**
 * 两种落地方式（`--subtitle-mode`）：
 *   · sidecar（缺省）：**母版不烧字**——出 `subtitles/<项目>.zh.srt|.zh.ass|.vtt` + 清单，
 *     后期想用就软轨内嵌（`mux` 阶段）或交给剪辑软件，不想用就当没这回事（画面像素从未被改）；
 *   · burn：仍把字烧进画面（另存 `master-subtitled.mp4`），母版变成带字版（发出去就回不来）。
 * 旁挂文件与烧录共用同一套字体选型 / 版式 / ASS 生成器（subtitle-bridge plan），所以两种形态观感一致。
 */
/** 未重跑字幕时，若磁盘上有"不早于当前上游"的字幕版就沿用它（只重跑后段的场景） */
let subtitled = STAGES.has("subtitle") ? colored : preferDownstream(join(POST_DIR, "master-subtitled.mp4"), colored, "subtitle");
/** 旁挂字幕文件（sidecar 模式的产物；burn 模式下为 null，下游仍走烧字版） */
let subtitleSidecar: { dir: string; srt: string; ass: string; manifest: string | null; timelineOk: boolean } | null = null;
if (STAGES.has("subtitle") && existsSync(colored)) {
  rememberInputs("subtitle", [colored]);
  const started = Date.now();
  const srtFile = join(POST_DIR, "subtitle.srt");
  writeFileSync(srtFile, buildSrt(), "utf8");
  const briefFile = BRIEF_FILE ? abs(BRIEF_FILE) : null;
  const platform = arg("--platform", "抖音/快手");

  if (SUBTITLE_MODE !== "burn") {
    const sidecarDir = join(POST_DIR, "subtitles");
    const sidecarResult = runCli(SUBTITLE_CLI, [
      "sidecar", "--in", colored, "--out-dir", sidecarDir, "--srt", srtFile, "--name", PROJECT,
      "--platform", platform,
      ...(briefFile ? ["--brief", briefFile] : [])
    ]);
    const zhSrt = join(sidecarDir, `${PROJECT}.zh.srt`);
    const zhAss = join(sidecarDir, `${PROJECT}.zh.ass`);
    const manifest = join(sidecarDir, `${PROJECT}.subtitle-manifest.json`);
    const timelineOk = sidecarResult.ok && /时间轴回读 ok/.test(sidecarResult.out);
    const verdict = await reviewStage({
      stage: "subtitle", projectId: PROJECT,
      artifacts: [
        { path: existsSync(zhSrt) ? zhSrt : srtFile, kind: "text", note: "旁挂字幕（母版未烧字）" },
        ...(existsSync(zhAss) ? [{ path: zhAss, kind: "text" as const, note: "带版式的 ASS（软轨/再烧同源）" }] : [])
      ],
      deterministic: [
        { id: "sidecar-produced", pass: existsSync(zhSrt) && existsSync(zhAss), detail: existsSync(zhSrt) ? "旁挂字幕文件已产出（srt + ass）" : "旁挂字幕文件未产出", hard: true },
        { id: "tool-exit", pass: sidecarResult.ok, detail: sidecarResult.ok ? "字幕工位退出码 0" : `字幕工位失败：${sidecarResult.out.slice(-300)}`, hard: true },
        { id: "timeline", pass: timelineOk, detail: (sidecarResult.out.match(/时间轴回读[^\n]*/) ?? ["无回读信息"])[0] ?? "" },
        { id: "master-untouched", pass: sidecarResult.out.includes("母版未被改动 ok"), detail: "母版只读：出字幕文件的过程不改动画面（哈希与 mtime 双验）", hard: true }
      ],
      context: { mode: SUBTITLE_MODE, srt: readFileSync(srtFile, "utf8").slice(0, 1200), platform, toolOutput: sidecarResult.out.slice(-900) },
      env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
    });
    if (existsSync(zhSrt)) {
      subtitleSidecar = { dir: sidecarDir, srt: zhSrt, ass: existsSync(zhAss) ? zhAss : zhSrt, manifest: existsSync(manifest) ? manifest : null, timelineOk };

    }
    record({
      stage: "subtitle", shotId: null, invoked: true, ok: sidecarResult.ok && Boolean(subtitleSidecar), cached: false, degraded: false,
      attempt: 1, ms: Date.now() - started, artifact: existsSync(zhSrt) ? zhSrt : null,
      evidence: { mode: "sidecar", srt: zhSrt, ass: zhAss, manifest, outputFiles: [zhSrt, zhAss, manifest], timelineOk, tool: "subtitle-bridge sidecar", masterBurnedIn: false }, verdict
    });
    if (!sidecarResult.ok || !subtitleSidecar || !verdict.approved) {
      throw new Error(`SUBTITLE_POST_FAILED: ${sidecarResult.out.slice(-400)}; ${verdict.reason}`);
    }
    log(`字幕以旁挂文件产出（母版不烧字）：${zhSrt}`);
  }

  if (SUBTITLE_MODE !== "sidecar") {
    const out = join(POST_DIR, "master-subtitled.mp4");
    /**
     * 片头标题卡（2026-09-27 真机事故）：字幕工位的 `burn --title` 会在**正片开头烧一张 3 秒标题卡**。
     * 上一版把片名原样（`AI 班组住进你公司 · 获客增长系统 89 秒销售口播`）传进去，
     * 大号标题横穿人物面部、两行还各自超宽——产品所有者看到的第一眼就是"排版乱"。
     * 纪律：
     *   · 封面卡已经承担片头标题时（本管线默认会产出并前置封面卡）**不再重复烧标题卡**；
     *   · 确需标题卡（`--no-open-with-cover` 或只跑字幕段）时，用**短标题**（取 `·` 前主标题、≤12 字），
     *     不再把整条片名塞进画面。
     */
    const coverCarriesTitle = STAGES.has("cover") || existsSync(join(OUT_DIR, `${PROJECT}-cover.png`));
    const burnOpeningTitle = shouldBurnOpeningTitle({ coverAvailable: coverCarriesTitle,
      noTitleCard: flag("--no-title-card"), explicitOpeningTitle: Boolean(arg("--opening-title")) });
    const openingTitle = arg("--opening-title", arg("--cover-hook", shotlist.title ?? ""))
      .split(/[·|｜]/)[0]!.trim().slice(0, 12);
    if (!burnOpeningTitle) {
      log(`  · 片头标题卡：跳过（${coverCarriesTitle ? "封面承担标题" : "--no-title-card 显式关闭"}）`);
    }
    const result = runCli(SUBTITLE_CLI, [
      "burn", "--in", colored, "--out", out, "--srt", srtFile,
      ...(burnOpeningTitle ? ["--title", openingTitle] : []),
      "--platform", platform,
      ...(briefFile ? ["--brief", briefFile] : []),
      "--evidence-dir", join(POST_DIR, "subtitle-evidence")
    ]);
    const info = existsSync(out) ? probe(out) : {};
    const verdict = await reviewStage({
      // 阶段名统一为 `subtitle`（历史裁决按阶段名检索：burn/sidecar 只是同一步的两种落地方式，
      // 命名分开会让"历史日志里有 subtitle 的放行裁决"这条链路完整性检查在本模式下误判缺失）
      stage: "subtitle", projectId: PROJECT,
      artifacts: [{ path: existsSync(out) ? out : colored, kind: "video", probe: info }, { path: srtFile, kind: "text" }],
      deterministic: [
        { id: "burned", pass: existsSync(out), detail: existsSync(out) ? "字幕版已产出" : "字幕版未产出", hard: true },
        { id: "tool-exit", pass: result.ok, detail: result.ok ? "字幕工位退出码 0" : `字幕工位失败：${result.out.slice(-300)}`, hard: true },
        /**
         * 标点口径（2026-09-25）：烧录模式没有旁挂清单可查，判据取自**字幕工位的实测输出**
         * （工位在烧录前会打印"标点体检 ok/fail"，它查的是真正写进画面的事件文本）。
         */
        {
          id: "punctuation", pass: /标点体检 ok/.test(result.out), hard: true,
          detail: (result.out.match(/标点体检[^\n]*/) ?? ["字幕工位未输出标点体检（无法证明字幕不带标点）"])[0]
        },
        { id: "timeline", pass: /时间轴回读 (\d+)\/(\d+) 条（一致）/.test(result.out) || result.out.includes("一致"), detail: (result.out.match(/时间轴回读[^\n]*/) ?? ["无回读信息"])[0] ?? "" }
      ],
      context: { mode: SUBTITLE_MODE, srt: readFileSync(srtFile, "utf8").slice(0, 1200), platform, toolOutput: result.out.slice(-900) },
      env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
    });
    if (existsSync(out)) subtitled = out;
    record({
      stage: "subtitle", shotId: null, invoked: true, ok: result.ok && existsSync(out), cached: false, degraded: false,
      attempt: 1, ms: Date.now() - started, artifact: existsSync(out) ? out : null,
      evidence: {
        mode: "burn", srt: srtFile, tool: "subtitle-bridge burn", masterBurnedIn: true,
        punctuationOk: /标点体检 ok/.test(result.out),
        punctuationDetail: (result.out.match(/标点体检[^\n]*/) ?? [null])[0]
      }, verdict
    });
    if (!result.ok || !existsSync(out) || !verdict.approved) {
      throw new Error(`SUBTITLE_POST_FAILED: ${result.out.slice(-400)}; ${verdict.reason}`);
    }
  } else {
    // sidecar 模式：画面这一路保持"未烧字"，下游（弹幕/配乐/封面）都从干净版派生
    subtitled = colored;
  }
}

/* ---------- ⑦ 弹幕（subtitle-bridge danmaku） ---------- */
/**
 * 弹幕层**可按项目关闭**（2026-09-25）：小红书这类内容社区没有弹幕文化，
 * 硬塞一层评点会显得违和。关闭时后续环节直接接字幕版（`master-subtitled.mp4`），
 * 并在阶段日志里留一条"显式跳过"，终审的血缘/层级检查也据此少一层（不冒充已执行）。
 */
const DANMAKU_ENABLED = !flag("--no-danmaku");

let danmakuOut = DANMAKU_ENABLED
  ? (STAGES.has("danmaku") ? subtitled : preferDownstream(join(POST_DIR, "master-danmaku.mp4"), subtitled, "danmaku"))
  : subtitled;
if (DANMAKU_ENABLED && STAGES.has("danmaku") && existsSync(subtitled)) {
  rememberInputs("danmaku", [subtitled]);
  const started = Date.now();
  const itemsFile = DANMAKU_FILE ? abs(DANMAKU_FILE) : join(POST_DIR, "danmaku.json");
  if (!DANMAKU_FILE) {
    /** 无现成弹幕稿：按镜头内容即时报文生成（评论语气，与画面语境一致） */
    const items: Array<Record<string, unknown>> = [];
    let cursor = 0.5;
    const pool = (shot: ShotCard): string[] => {
      const mood = String(shot.mood ?? "");
      return mood.includes("食")
        ? ["桂花糖粥绝了", "想吃海棠糕", "这条街有味道"]
        : mood.includes("俏皮") || mood.includes("生活气")
          ? ["评弹一响就上头", "巷子好好逛", "本地人路过"]
          : mood.includes("夜")
            ? ["夜景太温柔了", "灯笼好看", "已收藏"]
            : ["这也太好看了吧", "苏州真会养人", "想去走走"];
    };
    for (const shot of postShots()) {
      const duration = postShotSeconds(shot);
      const texts = pool(shot);
      texts.forEach((text, i) => {
        items.push({ text, at: Number((cursor + 0.8 + i * 1.4).toFixed(2)), mode: i === 1 ? "top" : "scroll" });
      });
      cursor += duration;
    }
    writeFileSync(itemsFile, `${JSON.stringify(items, null, 2)}\n`, "utf8");
  }
  const out = join(POST_DIR, "master-danmaku.mp4");
  const result = runCli(SUBTITLE_CLI, [
    "danmaku", "--in", subtitled, "--out", out, "--items", itemsFile,
    "--platform", arg("--platform", "B站"),
    "--evidence-dir", join(POST_DIR, "danmaku-evidence")
  ]);
  /** 声明关闭配乐层时，作品的音轨事实以"未加配乐的母版"为准（不是空对象——否则 audio-track 硬闸会误红） */
  const info = existsSync(out) ? probe(out) : {};
  const density = (result.out.match(/条数[^\n]*/) ?? ["无密度信息"])[0] ?? "";
  const verdict = await reviewStage({
    stage: "danmaku", projectId: PROJECT,
    artifacts: [{ path: existsSync(out) ? out : subtitled, kind: "video", probe: info }, { path: itemsFile, kind: "json" }],
    deterministic: [
      { id: "rendered", pass: existsSync(out), detail: existsSync(out) ? "弹幕版已产出" : "弹幕版未产出", hard: true },
      { id: "tool-exit", pass: result.ok, detail: result.ok ? "弹幕工位退出码 0" : `弹幕工位失败：${result.out.slice(-300)}`, hard: true },
      { id: "density", pass: /并发峰值 \d+\/8/.test(result.out), detail: density }
    ],
    context: { items: JSON.parse(readFileSync(itemsFile, "utf8")).slice(0, 12), toolOutput: result.out.slice(-700) },
    env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
  });
  if (existsSync(out)) danmakuOut = out;
  record({
    stage: "danmaku", shotId: null, invoked: true, ok: result.ok && existsSync(out), cached: false, degraded: false,
    attempt: 1, ms: Date.now() - started, artifact: existsSync(out) ? out : null, evidence: { items: itemsFile, tool: "subtitle-bridge danmaku" }, verdict
  });
  if (!result.ok || !existsSync(out) || !verdict.approved) {
    throw new Error(`DANMAKU_POST_FAILED: ${result.out.slice(-400)}; ${verdict.reason}`);
  }
}

/* ---------- ⑧ 配乐（bgm-bridge） ---------- */
const requestedBgmTracks = new Map<string, { requested: string; path: string; bpm: number | null }>();
/** A registered track ID and a local path use the same resolved bytes in every requested mix. */
async function resolveRequestedBgmTrack(requested: string): Promise<{ requested: string; path: string; bpm: number | null }> {
  let resolved = requestedBgmTracks.get(requested);
  if (!resolved) {
    if (existsSync(requested)) resolved = { requested, path: abs(requested), bpm: null };
    else {
      const core = await import(join(REPO_ROOT, "bundles/ai-video/connectors/bgm-bridge/core.mjs")) as {
        findTracks: (q: Record<string, unknown>) => { track?: { path?: string; bpm?: number } };
      };
      const track = core.findTracks({ trackId: requested, commercialUse: true }).track;
      if (!track?.path || !existsSync(track.path)) throw new Error(`BGM_TRACK_MISSING: ${requested}`);
      resolved = { requested, path: track.path, bpm: Number.isFinite(track.bpm) && Number(track.bpm) > 0 ? Number(track.bpm) : null };
    }
    requestedBgmTracks.set(requested, resolved);
  }
  if (!existsSync(resolved.path)) throw new Error(`BGM_TRACK_MISSING: ${requested}`);
  return resolved;
}
/** 未重跑配乐时沿用磁盘上不早于上游的配乐版；重跑则由下面的 bgm 环节覆盖 */
let scored = STAGES.has("bgm") ? danmakuOut : preferDownstream(join(POST_DIR, "master-scored.mp4"), danmakuOut, "bgm");
let coverIntroSeconds = 0;
if (STAGES.has("bgm") && existsSync(danmakuOut) && !DRY_RUN) {
  rememberInputs("bgm", [danmakuOut]);
  const started = Date.now(), out = join(POST_DIR, "master-scored.mp4");
  const genre = arg("--bgm-genre", "旅行"), mood = arg("--bgm-mood", "温润治愈");
  const policy = arg("--bgm-policy", "keep-dialogue"), chosenTrack = arg("--bgm-track", PRESENTATION?.main.bgm.path ?? "");
  if (PRESENTATION) verifyPresentationAsset(PRESENTATION.main.bgm);
  if (flag("--no-music")) {
    bgmManifestInfo = { layer: "off", applicable: false, reason: "用户明确 --no-music", sourceAuthority: "original-program-bytes", stemsVerified: false };
    record({ stage: "bgm", shotId: null, invoked: false, ok: true, cached: false, degraded: false, attempt: 1,
      ms: Date.now() - started, artifact: danmakuOut, evidence: { ...bgmManifestInfo, qualityReviewed: false },
      verdict: null, note: "按明确请求保留原节目，不生成音乐层" });
  } else {
    const mixArgs = ["--in", danmakuOut, "--out", out, "--policy", policy,
      "--music-level", arg("--bgm-level", "-26"), "--ducking", arg("--bgm-ducking", "14"),
      "--lufs", String(BGM_TARGET_LUFS), "--true-peak", arg("--bgm-true-peak", "-1.5"),
      "--section", arg("--bgm-section", "auto"), "--bpm-strategy", "cut-driven", "--cut-times", CUT_GRID.join(","),
      "--evidence-dir", join(POST_DIR, "bgm-evidence")];
    const resolvedTrack = chosenTrack ? await resolveRequestedBgmTrack(chosenTrack) : null;
    const trackPath = resolvedTrack?.path ?? "";
    if (resolvedTrack?.bpm) mixArgs.push("--bgm-bpm", String(resolvedTrack.bpm));
    if (trackPath) rememberInputs("bgm", [danmakuOut, trackPath]);
    const result = chosenTrack
      ? runCli(BGM_CLI, ["mix", ...mixArgs, "--bgm", trackPath])
      : runCli(BGM_CLI, ["best", ...mixArgs, "--genre", genre, "--mood", mood,
        "--source-policy", arg("--bgm-source-policy", "local-only"),
        ...(arg("--bgm-recipe") ? ["--recipe", arg("--bgm-recipe")] : [])]);
    const info = existsSync(out) ? probe(out) : {};
    const verdict = await reviewStage({ stage: "bgm", projectId: PROJECT,
      artifacts: existsSync(out) ? [{ path: out, kind: "video", probe: info }] : [],
      deterministic: [{ id: "output-produced", pass: existsSync(out), hard: true, detail: "请求的配乐成片已落盘" },
        { id: "tool-exit", pass: result.ok, hard: true, detail: result.ok ? "正式混音退出码0" : result.out.slice(-300) }],
      context: { genre, mood, policy, qualityReviewed: false }, env: ENV });
    bgmManifestInfo = { layer: "on", via: chosenTrack ? "requested-track-once" : "deterministic-recipe-once",
      sourceAuthority: "original-program-bytes", stemsVerified: false, output: existsSync(out) ? basename(out) : null,
      requestedTrack: chosenTrack || null, resolvedTrackPath: trackPath || null, qualityReviewed: false };
    record({ stage: "bgm", shotId: null, invoked: true, ok: result.ok && verdict.approved, cached: false,
      degraded: false, attempt: 1, ms: Date.now() - started, artifact: existsSync(out) ? out : null,
      evidence: { ...bgmManifestInfo, ...info, policy, tool: "bgm-bridge", toolOutput: result.out.slice(-700) }, verdict });
    if (!result.ok || !verdict.approved) throw new Error(`BGM_POST_FAILED: ${result.out.slice(-400)}; ${verdict.reason}`);
    scored = out;
  }
}

/* ---------- ⑧-2 转场音效层（step_key: sfx，《瞭望塔》式城市片的第三层声音，2026-09-25 新增） ---------- */
/**
 * 拉片结论（`docs/watchtower-deconstruction.md` §三/§六）：这类片子听感的一半来自**剪辑点上的音效**——
 * 甩镜有气流（whoosh）、段落重音有冲击（impact）、进入高潮前有抬升（riser）。
 * 本阶段把这层补上，且全部**合成**（无第三方采样，确定性可复现）：
 *   ① 从镜头时长 + 逐刀转场参数推出剪辑点（与 compose 的 xfade 口径一致）；
 *   ② 每个剪辑点铺 whoosh、段落重音铺 impact、高潮前铺 riser（`planCutSfx`）；
 *   ③ 合成音效 → 逐条 adelay 拼成 SFX 轨 → 与母版音轨混音（视频轨 copy）；
 *   ④ 复核：响度仍在 −14 LUFS ±1.5、剪辑点窗口内确有新增能量（"做了但听不见"要被抓出来）。
 */
if (STAGES.has("sfx") && existsSync(scored) && !DRY_RUN) {
  rememberInputs("sfx", [scored]);
  const started = Date.now();
  const sfxDir = join(POST_DIR, "sfx");
  mkdirSync(sfxDir, { recursive: true });
  const totalDuration = Number(probe(scored).duration ?? 0);
  const shotDurations = postShots().map(postShotSeconds);
  if (POST_END_CARD_SECONDS) shotDurations.push(POST_END_CARD_SECONDS);
  const cutTimes = cutTimesFromShots(shotDurations, EFFECTIVE_CUT_TRANSITION ? CUT_TRANSITION_DURATION : 0,
    EFFECTIVE_CUT_TRANSITION ? EFFECTIVE_CUT_TRANSITION_AT.split(",").map((v) => Number(v.trim())).filter((v) => Number.isFinite(v) && v > 0) : []);
  /** 段落重音 = 进入快剪段的第一刀 + 最后一刀（模板可覆盖） */
  const accentTimes = cutTimes.length > 1 ? [cutTimes[0]!, cutTimes[cutTimes.length - 1]!] : cutTimes.slice(0, 1);
  /**
   * 高潮那一刻 = 最后一个重音刀口（进入收尾镜之前）。
   * riser 由策划器**前置**到高潮之前（真机打回：riser 落在切点之后 = 高潮过去了才抬升）。
   */
  const climaxAtSec = accentTimes.length > 0 ? accentTimes[accentTimes.length - 1] : undefined;
  const sfxPlan = planCutSfxDetailed({ cutTimes, durationSec: totalDuration, accentTimes, climaxAtSec }, CUT_SFX_POLICY);
  /**
   * 开场钩子音（2026-09-27）：0–0.6s 是转场音效覆盖不到的窗口，单独摆一条。
   * 与转场音效的冲突在这里显式消解（不是静默丢弃）：钩子音**优先**——它是前 3 秒机制的一部分，
   * 被它挤掉的剪辑点音效如实记进 `hookConflicts`。
   */
  const hookPlacement = planHookSfx({
    enabled: hookSfxEnabled && existsSync(scored),
    atSec: hookSfxSpec.atSec, kind: hookSfxSpec.kind, gainDb: hookSfxSpec.gainDb
  });
  const hookConflicts = hookPlacement
    ? sfxPlan.placements.filter((placement) => Math.abs(placement.atSec - hookPlacement.atSec) < CUT_SFX_POLICY.minGapSec)
    : [];
  const placements = [
    ...(hookPlacement ? [hookPlacement] : []),
    ...sfxPlan.placements.filter((placement) => !hookConflicts.includes(placement))
  ];
  try {
    const files: string[] = [];
    const renderOne = (kind: "whoosh" | "impact" | "riser", durationSec: number, file: string): void => {
      run(FFMPEG, ["-y", ...buildSfxArgs({ kind, durationSec }), "-f", "wav", file]);
    };
    placements.forEach((placement, index) => {
      const file = join(sfxDir, `${String(index + 1).padStart(2, "0")}-${placement.kind}-${placement.atSec}s.wav`);
      /** 钩子音按 `HOOK_SFX_POLICY.durationSec`（0.26s 收在 0–0.6s 窗口内），剪辑点音效按各音色默认时长 */
      const durationSec = hookPlacement && placement === hookPlacement
        ? HOOK_SFX_POLICY.durationSec
        : (placement.kind === "riser" ? 1.2 : placement.kind === "impact" ? 0.26 : 0.36);
      renderOne(placement.kind, durationSec, file);
      files.push(file);
    });
    const sfxTrack = join(sfxDir, "sfx-track.wav");
    if (placements.length === 0) {
      log("  ⚠ 没有剪辑点可铺音效（跳过 SFX 层）");
      record({
        stage: "sfx", shotId: null, invoked: false, ok: true, cached: false, degraded: false, attempt: 1, ms: Date.now() - started,
        artifact: scored, evidence: { placements: 0, cutTimes, applicable: false, qualityReviewed: false }, verdict: null, note: "无剪辑点：SFX 层未产出（如实记录，不静默）"
      });
    } else {
      /** 合成 SFX 轨：每条音效按 atSec 延迟后混在一起（amix 不做响度归一，避免把短音效拉爆） */
      const inputs = placements.map((_, index) => `-i ${JSON.stringify(files[index]!)}`).join(" ");
      const delays = placements.map((placement, index) =>
        `[${index}:a]adelay=${Math.round(placement.atSec * 1000)}|${Math.round(placement.atSec * 1000)},volume=${placement.gainDb}dB[a${index}]`
      ).join(";");
      const mixInputs = placements.map((_, index) => `[a${index}]`).join("");
      run(FFMPEG, ["-y", ...placements.flatMap((_, index) => ["-i", files[index]!]),
        "-filter_complex", `${delays};${mixInputs}amix=inputs=${placements.length}:normalize=0:dropout_transition=0,apad[aout]`,
        "-map", "[aout]", "-t", totalDuration.toFixed(3), "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", sfxTrack]);
      void inputs;
      /** 与母版混音：视频轨 copy，音轨 = 母版 + SFX（SFX 已在摆放阶段设过增益） */
      const out = join(POST_DIR, "master-sfx.mp4");
      run(FFMPEG, ["-y", "-i", scored, "-i", sfxTrack,
        "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=first:normalize=0[aout]",
        "-map", "0:v:0", "-map", "[aout]",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
        "-movflags", "+faststart", out]);
      const verdict = await reviewStage({ stage: "sfx", projectId: PROJECT,
        artifacts: [{ path: out, kind: "video", probe: probe(out) }],
        deterministic: [{ id: "sfx-produced", pass: existsSync(out), hard: true, detail: "请求的音效成片已落盘" }],
        context: { placements, cutTimes, qualityReviewed: false }, env: ENV });
      if (!verdict.approved) throw new Error(`SFX_POST_FAILED: ${verdict.reason}`);
      if (existsSync(out) && verdict.approved) scored = out;
      record({
        stage: "sfx", shotId: null, invoked: true, ok: verdict.approved && existsSync(out), cached: false,
        degraded: verdict.degraded, attempt: 1, ms: Date.now() - started, artifact: existsSync(out) ? out : null,
        evidence: {
          placements: placements.map((p) => ({ atSec: p.atSec, kind: p.kind, gainDb: p.gainDb, reason: p.reason })),
          dropped: sfxPlan.dropped.map((p) => ({ atSec: p.atSec, kind: p.kind, reason: p.reason })),
          hook: hookPlacement ? { atSec: hookPlacement.atSec, kind: hookPlacement.kind, gainDb: hookPlacement.gainDb, reason: hookPlacement.reason } : null,
          hookConflicts: hookConflicts.map((p) => ({ atSec: p.atSec, kind: p.kind, reason: "被开场钩子音挤掉（0–0.6s 内不与剪辑点音效叠加）" })),
          climaxAtSec, cutTimes, qualityReviewed: false,
          tool: "sfx-synth（合成，无第三方采样）"
        },
        verdict, note: `音效 ${placements.length} 条（whoosh/impact/riser）${hookPlacement ? " · 含开场钩子音" : ""}`
      });
    }
  } catch (err) {
    record({
      stage: "sfx", shotId: null, invoked: true, ok: false, cached: false, degraded: false, attempt: 1,
      ms: Date.now() - started, artifact: null,
      evidence: { error: err instanceof Error ? err.message.slice(0, 300) : String(err) }, verdict: null
    });
    throw err;
  }
}

/* ---------- ⑨ 封面：一次请求取帧 + 正式字体与版式变换 ---------- */
if (STAGES.has("cover") && existsSync(colored) && !DRY_RUN) {
  const started = Date.now(), coverPng = join(OUT_DIR, `${PROJECT}-cover.png`);
  const coverSpec = getCoverSpec(COVER_PLATFORM_ARG || arg("--platform", "抖音"));
  const coverResolution: [number, number] = [coverSpec.canvas.width, coverSpec.canvas.height];
  const post = await import(join(REPO_ROOT, "bundles/ai-video/connectors/post-bridge/core.mjs")) as {
    buildCover: (options: Record<string, unknown>) => Promise<{ output: string; width: number; height: number;
      sha256: string; bytes: number; at: number; frame: string; assPath: string; checks: Array<{ kind: string; ok: boolean }> }>;
  };
  rememberInputs("cover", [colored]);
  if (PRESENTATION) {
    verifyPresentationAsset(PRESENTATION.main.cover);
    rememberInputs("cover", [colored, PRESENTATION.main.cover.path]);
    copyFileSync(PRESENTATION.main.cover.path, coverPng);
  }
  const coverInfo = PRESENTATION ? probe(coverPng) : null;
  const result = PRESENTATION ? { output: coverPng, sha256: fingerprintArtifact(coverPng).sha256,
    bytes: statSync(coverPng).size, width: Number(coverInfo?.width), height: Number(coverInfo?.height),
    frame: "", assPath: "", at: 0, checks: [] } : await post.buildCover({ input: colored, output: coverPng,
    project: { projectId: PROJECT, title: arg("--cover-hook", shotlist.title ?? PROJECT), platform: coverSpec.id },
    variant: { id: "main", cover: { at: Number(arg("--cover-at", "0.35")), subtitle: arg("--cover-subtitle", "") } },
    resolution: coverResolution, platform: coverSpec.id, bins: { ffmpeg: FFMPEG, ffprobe: FFPROBE }, workDir: POST_DIR });
  const verdict = await reviewStage({ stage: "cover", projectId: PROJECT,
    artifacts: [{ path: coverPng, kind: "image" }], deterministic: [
      { id: "cover-size", pass: result.width === coverResolution[0] && result.height === coverResolution[1],
        hard: true, detail: `请求 ${coverResolution.join("x")}，实际 ${result.width}x${result.height}` }],
    context: { qualityReviewed: false, platform: coverSpec.id }, env: ENV });
  record({ stage: "cover", shotId: null, invoked: true, ok: verdict.approved, cached: false, degraded: false,
    attempt: 1, ms: Date.now() - started, artifact: coverPng,
    evidence: { ...result, qualityReviewed: false, designVia: "requested-recipe-once", source: colored,
      coverPlatform: { id: coverSpec.id, canvas: coverSpec.canvas }, outputFiles: [result.frame, result.assPath].filter(Boolean), ...(PRESENTATION ? { presentation: PRESENTATION.main } : {}) }, verdict });
  if (!verdict.approved) throw new Error(`COVER_POST_FAILED: ${verdict.reason}`);
  if (!flag("--no-open-with-cover") && existsSync(scored)) {
    const body = scored, withCover = join(OUT_DIR, `${PROJECT}-with-cover.mp4`);
    rememberInputs("cover-intro", [coverPng, body]);
    const receipt = prependFilmCover({ body, cover: coverPng, output: withCover, ffmpeg: FFMPEG, ffprobe: FFPROBE,
      fps: FPS, width: OUTPUT_SIZE.width, height: OUTPUT_SIZE.height,
      ...(PRESENTATION ? { music: PRESENTATION.main.bgm.path } : {}) });
    coverIntroSeconds = receipt.introSeconds;
    record({ stage: "cover-intro", shotId: null, invoked: true, ok: true, cached: false, degraded: false,
      attempt: 1, ms: Date.now() - started, artifact: withCover,
      evidence: { ...receipt, qualityReviewed: false }, verdict: null });
    scored = withCover;

  }
}

/* ---------- ⑩ 软字幕轨收口（母版不烧字 + 字幕可开关） ---------- */
/**
 * 旁挂字幕的两种用法在这里分叉：
 *   · 交付目录里保留 `.srt/.ass/.vtt` 文件（平台后台上传口 / 剪辑软件用）；
 *   · 另出一支 `-softsub.mp4`：字幕作为**可开关的字幕轨**内嵌，视频/音频执行 copy
 *     （实际轨道元数据、源文件哈希与字幕轨数，未做画面品质复评）。
 * 这样"要带字幕的片子"和"不要字幕的片子"是同一个画面母版派生的两个文件，不会各烧一遍。
 */
if (!subtitleSidecar && SUBTITLE_MODE !== "burn" && stageApproved("subtitle")) {
  const sidecarDir = join(POST_DIR, "subtitles"), srt = join(sidecarDir, `${PROJECT}.zh.srt`), ass = join(sidecarDir, `${PROJECT}.zh.ass`), manifest = join(sidecarDir, `${PROJECT}.subtitle-manifest.json`);
  if ([srt, ass, manifest].every((file) => existsSync(file))) {
    const doc = JSON.parse(readFileSync(manifest, "utf8")) as { checks?: Array<{ kind?: string; ok?: boolean }> };
    const timelineOk = doc.checks?.some((check) => check.kind === "timeline_readback" && check.ok === true) === true;
    if (timelineOk) subtitleSidecar = { dir: sidecarDir, srt, ass, manifest, timelineOk };
  }
}
if (coverIntroSeconds > 0 && subtitleSidecar) {
  const shifted = join(POST_DIR, "subtitles-with-cover");
  shiftFilmSubtitleDirectory(subtitleSidecar.dir, shifted, readdirSync(subtitleSidecar.dir), coverIntroSeconds);
  subtitleSidecar = { ...subtitleSidecar, dir: shifted, srt: join(shifted, basename(subtitleSidecar.srt)),
    ass: join(shifted, basename(subtitleSidecar.ass)), timelineOk: false };
}
let softsubFile: string | null = null;
if (STAGES.has("mux") && subtitleSidecar && existsSync(scored) && !DRY_RUN) {
  rememberInputs("mux", [scored, subtitleSidecar.srt, subtitleSidecar.ass]);
  const started = Date.now();
  const deliverSubtitleDir = join(OUT_DIR, "subtitles");
  mkdirSync(deliverSubtitleDir, { recursive: true });
  for (const name of readdirSync(subtitleSidecar.dir)) {
    if (!/\.(srt|ass|vtt|json)$/i.test(name)) continue;
    execFileSync("cp", [join(subtitleSidecar.dir, name), join(deliverSubtitleDir, name)]);
  }
  const out = join(OUT_DIR, `${PROJECT}-softsub.mp4`);
  const result = runCli(SUBTITLE_CLI, [
    "softmux", "--in", scored, "--out", out,
    "--srt", join(deliverSubtitleDir, `${PROJECT}.zh.srt`),
    "--lang", arg("--subtitle-lang", "chi"),
    ...(existsSync(join(deliverSubtitleDir, `${PROJECT}.en.srt`))
      ? ["--srt-en", join(deliverSubtitleDir, `${PROJECT}.en.srt`), "--lang-en", "eng"]
      : [])
  ]);
  const info = existsSync(out) ? probe(out) : {};
  const verdict = await reviewStage({
    stage: "mux", projectId: PROJECT,
    artifacts: [
      ...(existsSync(out) ? [{ path: out, kind: "video" as const, probe: info, note: "软字幕轨版（字幕可开关，画面零改动）" }] : []),
      ...(existsSync(join(deliverSubtitleDir, `${PROJECT}.zh.srt`))
        ? [{ path: join(deliverSubtitleDir, `${PROJECT}.zh.srt`), kind: "text" as const, note: "交付目录里的旁挂字幕" }]
        : [])
    ],
    deterministic: [
      { id: "softsub-produced", pass: existsSync(out), detail: existsSync(out) ? "软字幕轨版已产出" : "软字幕轨版未产出", hard: true },
      { id: "tool-exit", pass: result.ok, detail: result.ok ? "字幕工位退出码 0" : `软轨内嵌失败：${result.out.slice(-300)}`, hard: true },
      { id: "requested-transform", pass: result.out.includes("video_metadata_preserved=ok"), detail: (result.out.match(/复检：[^\n]*/) ?? ["无复检信息"])[0] ?? "", hard: true },
      { id: "subtitle-files", pass: existsSync(join(deliverSubtitleDir, `${PROJECT}.zh.srt`)), detail: "交付目录含旁挂字幕文件（平台上传口/剪辑软件可直接用）", hard: true }
    ],
    context: { mode: SUBTITLE_MODE, toolOutput: result.out.slice(-900), softsub: out },
    env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
  });
  if (existsSync(out)) softsubFile = out;
  record({
    stage: "mux", shotId: null, invoked: true, ok: result.ok && existsSync(out), cached: false, degraded: false,
    attempt: 1, ms: Date.now() - started, artifact: existsSync(out) ? out : null,
    evidence: { tool: "subtitle-bridge softmux", subtitlesDir: deliverSubtitleDir, streamCopy: { video: true, audio: true, metadataPreserved: result.out.includes("video_metadata_preserved=ok"), decodedFrameComparison: false }, qualityReviewed: false }, verdict
  });
  if (!result.ok || !existsSync(out) || !verdict.approved) {
    throw new Error(`MUX_POST_FAILED: ${result.out.slice(-400)}; ${verdict.reason}`);
  }
  if (existsSync(out)) {
    log(`软字幕轨版：${out}（视频/音频 copy；源字节保持；旁挂字幕在 ${deliverSubtitleDir}）`);
  }
}

/* ---------- ⑪ 母版交付 + 终审 ---------- */
if (STAGES.has("master") && existsSync(scored) && !DRY_RUN) {
  rememberInputs("master", [scored]);

  const scoredInfo = probe(scored);
  if (Number(scoredInfo.width) !== OUTPUT_SIZE.width || Number(scoredInfo.height) !== OUTPUT_SIZE.height) {
    record({
      stage: "master", shotId: null, invoked: true, ok: false, cached: false, degraded: false, attempt: 1, ms: 0,
      artifact: scored,
      evidence: { quality: QUALITY, expected: OUTPUT_SIZE, actual: { width: scoredInfo.width, height: scoredInfo.height } },
      verdict: null, note: "交付分辨率不符，禁止把预览或旧缓存签成正式母版"
    });
    throw new Error(`交付分辨率不符：${scoredInfo.width}x${scoredInfo.height}，要求 ${OUTPUT_SIZE.width}x${OUTPUT_SIZE.height}`);
  }
  /**
   * 文件名与成片时长**同源**：先量实际时长，再决定交付文件名（不再写死 30s）。
   * 审计口径见 `auditDeliverableNaming`：文件名里写明的时长与成片差 >1s 即判不合格。
   */
  const namingAudit = auditDeliverableNaming({ path: DELIVERABLE, durationSec: Number(scoredInfo.duration ?? 0) });
  const finalPath = namingAudit.suggestedName ? join(OUT_DIR, namingAudit.suggestedName) : DELIVERABLE;
  const deliverable = scored; // 先审工作产物，批准后才发布到交付目录。
  if (finalPath !== DELIVERABLE) {
    log(`ℹ 成片 ${Number(scoredInfo.duration ?? 0).toFixed(2)}s：交付文件名按实测时长改写为 ${basename(finalPath)}（旧名 ${basename(DELIVERABLE)}）`);
  }
  deliverablePath = finalPath;
  /** UHD 只在终审放行后发布正式文件；失败候选留在后期缓存供审计和返修。 */
  const reviewFile = QUALITY === "uhd" ? join(POST_DIR, `${PROJECT}-master-review.mp4`) : deliverable;
  if (QUALITY === "uhd") copyFileSync(scored, reviewFile);
  const info = probe(reviewFile);

  const finalNamingAudit = auditDeliverableNaming({ path: finalPath, durationSec: Number(info.duration ?? 0) });
  const history = readStageHistory();
  const stageSummary = { total: records.length, invoked: records.filter(row => row.invoked).length,
    ok: records.filter(row => row.ok).length, failed: records.filter(row => !row.ok && row.invoked).length,
    degraded: records.filter(row => row.degraded).length, cached: records.filter(row => row.cached).length,
    skipped: [...STAGES].filter(stage => !records.some(row => row.stage.startsWith(stage))).length };
  const verdict = await reviewStage({
    stage: "master", projectId: PROJECT,
    rubric: scenePolicy ? [...PRODUCER_RUBRICS.master, scenePolicy.prompt.visualReview] : undefined,
    /**
     * 终审证据包（2026-09-24 真机修正）：只给成片本体时，监制会凭"看不到封面产物"判定"封面阶段被跳过"。
     * 这里把封面 PNG、阶段汇总 JSON 一并作为产物附件交给它审。
     */
    artifacts: [
      { path: reviewFile, kind: "video", bytes: Number(info.bytes ?? 0), probe: info },
      ...(existsSync(join(OUT_DIR, `${PROJECT}-cover.png`)) ? [{ path: join(OUT_DIR, `${PROJECT}-cover.png`), kind: "image" as const, note: "封面产物" }] : []),
      ...(softsubFile ? [{ path: softsubFile, kind: "video" as const, note: "软字幕轨版（字幕可开关、画面零改动）" }] : []),
      ...(subtitleSidecar ? [{ path: subtitleSidecar.srt, kind: "text" as const, note: "旁挂字幕文件（母版未烧字）" }] : []),
      { path: STAGE_LOG, kind: "json", note: "逐环节阶段日志（invoked/ok/degraded/cached/verdict）" }
    ],
    deterministic: [
      { id: "duration", pass: Number(info.duration ?? 0) > 0,
        detail: `实际交付 ${Number(info.duration ?? 0).toFixed(3)}s；创作目标 ${totalSeconds}s仅作观测，原速完整保留`, hard: true },
      { id: "resolution", pass: Number(info.width) === OUTPUT_SIZE.width && Number(info.height) === OUTPUT_SIZE.height,
        detail: `${info.width}x${info.height}；导出目标 ${OUTPUT_SIZE.width}x${OUTPUT_SIZE.height}`, hard: true },
      { id: "deliverable-naming", pass: finalNamingAudit.ok, detail: finalNamingAudit.detail, hard: true },
      ...(STAGES.has("subtitle") ? [{ id: "subtitle-delivery", hard: true,
        pass: SUBTITLE_MODE === "burn" ? existsSync(join(POST_DIR, "master-subtitled.mp4"))
          : Boolean(subtitleSidecar && existsSync(subtitleSidecar.srt) && existsSync(subtitleSidecar.ass)),
        detail: "本次明确请求的字幕转换须留下真实文件" }] : []),
      ...(STAGES.has("cover") ? [{ id: "cover-delivery", hard: true,
        pass: existsSync(join(OUT_DIR, `${PROJECT}-cover.png`)), detail: "本次封面输出须真实存在" }] : [])
    ],
    context: { stageSummary, stages: [...STAGES], policy: POST_RENDER_ACCEPTANCE_POLICY, qualityReviewed: false },
    env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
  });
  let published = false;
  if (verdict.approved && !verdict.degraded) {
    const pending = join(OUT_DIR, `.${basename(finalPath)}.${randomUUID()}.pending`);
    try {
      const reviewed = lineageInputSnapshots.get("master:")?.artifacts.find((entry) => entry.path === resolve(scored));
      const current = fingerprintArtifact(scored);
      if (!reviewed || reviewed.sha256 !== current.sha256 || reviewed.realpath !== current.realpath
        || fingerprintArtifact(reviewFile).sha256 !== reviewed.sha256) {
        throw new Error("MASTER_CHANGED_DURING_REVIEW");
      }
      copyFileSync(reviewFile, pending, fsConstants.COPYFILE_EXCL);
      if (fingerprintArtifact(pending).sha256 !== reviewed.sha256
        || fingerprintArtifact(reviewFile).sha256 !== reviewed.sha256
        || fingerprintArtifact(scored).sha256 !== reviewed.sha256) {
        throw new Error("MASTER_CHANGED_DURING_PUBLICATION");
      }
      renameSync(pending, finalPath);
      published = true;
      masterApprovedForUhd = QUALITY === "uhd";
    } catch (error) {
      rmSync(pending, { force: true });
      record({
        stage: "master", shotId: null, invoked: true, ok: false, cached: false, degraded: false,
        attempt: 1, ms: verdict.ms, artifact: reviewFile,
        evidence: { quality: QUALITY, publishError: error instanceof Error ? error.message : String(error) }, verdict,
        note: "终审放行但原子发布失败；正式交付中止"
      });
      throw error;
    }
  }
  deliverablePath = published ? finalPath : reviewFile;
  record({
    stage: "master", shotId: null, invoked: true, ok: published, cached: false, degraded: verdict.degraded,
    attempt: 1, ms: verdict.ms, artifact: deliverablePath,
    evidence: { ...info, quality: QUALITY, sourceResolution: SOURCE_RESOLUTION, outputResolution: OUTPUT_RESOLUTION, stageSummary }, verdict
  });
  writeFileSync(join(LOG_DIR, "stage-summary.json"), `${JSON.stringify({ project: PROJECT, at: stamp(), summary: stageSummary, deliverable: deliverablePath, records }, null, 2)}\n`, "utf8");
  /**
   * 终审结论要如实说：`✅ 成片` 只在监制放行时出现；未放行时输出 ⚠ + 理由，
   * 避免"文件存在"被读成"已通过"。
   */
  if (published) log(`✅ 成片（正式后期导出；未做源质量评审）：${deliverablePath}`);
  else if (QUALITY === "uhd") {
    log(`⛔ UHD 母版导出技术失败：${verdict.reason}\n   审查候选：${reviewFile}（未发布到交付目录）`);
    throw new Error(`UHD 母版终审未放行：${verdict.reason}`);
  } else {
    log(`⛔ 母版导出技术失败：${verdict.reason}；保留工作产物 ${reviewFile}`);
    throw new Error(`MASTER_EXPORT_FAILED: ${verdict.reason}; 工作产物 ${reviewFile}`);
  }
}

/* ---------- ⑫ 多风格交付包（step_key: deliver：请求的文件必须实际产出） ---------- */
if (QUALITY === "uhd" && STAGES.has("deliver") && !DRY_RUN && !masterApprovedForUhd) {
  throw new Error("UHD 多风格交付缺本轮终审放行的母版；请先完成母版终审");
}
/**
 * 管线 yml 的 deliver 步：干净母版、旁挂字幕、请求的风格变体、软字幕轨版与交付清单，
 * 纪律是"镜头只生成一次，变体零 token"——变体只做**后期层派生**（调色/混音/文案），绝不重跑渲染。
 * `G-DLV1` 只检查请求文件是否实际产出；显式单变体可交付，不做画面、声音或封面差异评分。
 */
if (STAGES.has("deliver") && !DRY_RUN && (QUALITY !== "uhd" || masterApprovedForUhd)
  && artifactReusable("master", deliverablePath, scored)) {
  const deliveryInputPaths = [deliverablePath];
  rememberInputs("deliver", deliveryInputPaths);
  const started = Date.now();
  /**
   * 从尚未添加当前配乐的字幕/节目层派生请求变体，避免重复叠加配乐。
   * 各变体按真实请求与配方生成文件；没有配乐可闻度或跨变体差异品质二检。
   */
  const variantSource = danmakuOut;
  deliveryInputPaths.push(variantSource);
  const requestedVariantTrack = !flag("--no-music") && arg("--bgm-track", "")
    ? await resolveRequestedBgmTrack(arg("--bgm-track", "")) : null;
  if (requestedVariantTrack) deliveryInputPaths.push(requestedVariantTrack.path);
  rememberInputs("deliver", deliveryInputPaths);
  const allVariantPlans = buildVariantPlan({ master: variantSource, outDir: OUT_DIR, projectId: PROJECT,
    coverHook: arg("--cover-hook", shotlist.title ?? "") });
  const requestedVariantIds = arg("--variants", "").split(",").map(id => id.trim()).filter(Boolean);
  if (new Set(requestedVariantIds).size !== requestedVariantIds.length
    || requestedVariantIds.some(id => !allVariantPlans.some(plan => plan.variant.id === id))) {
    throw new Error("VARIANT_REQUEST_INVALID: 变体ID重复或未定义");
  }
  const variantPlans = requestedVariantIds.length ? allVariantPlans.filter(plan => requestedVariantIds.includes(plan.variant.id)) : allVariantPlans;
  const samples: [] = [], distinctness = null, variantAxes = null;
  const variantManifest: Array<{ id: string; label: string; path: string; sha256: string; note: string;
    gradeProfile: string | null; width: number; height: number; cover: { path: string; sha256: string } | null;
    bgm: { track: string; sha256: string } | null;
    title?: string; fontName?: string; fontSha256?: string;
    coverIntro?: { seconds: number; bodySha256: string; coverSha256: string } }> = [];
  const usedVariantMusic = new Set<string>();
  const chooseVariantMusic = async (genre: string, mood: string): Promise<{ requested: string; path: string; bpm: number | null } | null> => {
    const core = await import(join(REPO_ROOT, "bundles/ai-video/connectors/bgm-bridge/core.mjs")) as {
      findTracks: (query: Record<string, unknown>) => { items: Array<{ id: string; path?: string; fileExists?: boolean; genre?: string; mood?: string; bpm?: number | null }> };
    };
    const genreTerms = genre.split("|").filter(Boolean), moodTerms = mood.split("|").filter(Boolean);
    const score = (row: { genre?: string; mood?: string }) => genreTerms.filter(term => String(row.genre).includes(term)).length * 2
      + moodTerms.filter(term => String(row.mood).includes(term)).length;
    const candidates = core.findTracks({ limit: 5000, commercialUse: true }).items
      .filter(row => row.fileExists && row.path && !usedVariantMusic.has(sha256FileSync(row.path)))
      .sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
    const row = candidates[0];
    return row?.path ? { requested: row.id, path: row.path, bpm: row.bpm ?? null } : null;
  };
  const post = await import(join(REPO_ROOT, "bundles/ai-video/connectors/post-bridge/core.mjs")) as {
    buildCover: (options: Record<string, unknown>) => Promise<{ output: string; sha256: string }>;
  };
  const coverSpec = getCoverSpec(COVER_PLATFORM_ARG || arg("--platform", "抖音"));
  for (const plan of variantPlans) {
    try {
      const style = PRESENTATION?.variants.find(row => row.id === plan.variant.id);
      if (style) { verifyPresentationAsset(style.font); verifyPresentationAsset(style.endCard); }
      if (plan.passthrough) copyFileSync(variantSource, plan.output);
      else {
        const grade = runCli(COLOR_CLI, [...plan.gradeArgs, "--out", plan.output]);
        if (!grade.ok) throw new Error(`VARIANT_COLOR_FAILED: ${grade.out.slice(-400)}`);
      }
      if (style && POST_END_CARD_SECONDS > 0) {
        const withCard = join(POST_DIR, `${plan.variant.id}-end-card.mp4`);
        run(FFMPEG, ["-v", "error", "-y", "-i", plan.output, "-loop", "1", "-i", style.endCard.path,
          "-filter_complex", `[1:v]scale=${OUTPUT_SIZE.width}:${OUTPUT_SIZE.height},format=rgba[card];[0:v][card]overlay=enable='gte(t,${(expectedMasterSeconds - POST_END_CARD_SECONDS).toFixed(6)})':shortest=1[v]`,
          "-map", "[v]", "-map", "0:a:0", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "copy", withCard]);
        renameSync(withCard, plan.output);
      }
      const source = inspectPostInput({ file: plan.output, ffprobe: FFPROBE });
      if (source.width !== OUTPUT_SIZE.width || source.height !== OUTPUT_SIZE.height) throw new Error(`VARIANT_EXPORT_DIMENSIONS_INVALID: ${plan.variant.id}`);
      let variantBgm: { track: string; sha256: string } | null = null;
      if (!flag("--no-music")) {
        if (style) verifyPresentationAsset(style.bgm);
        const track = style ? { requested: style.bgm.id, path: style.bgm.path, bpm: null }
          : requestedVariantTrack ?? await chooseVariantMusic(plan.variant.bgmGenre, plan.variant.bgmMood);
        if (track) {
          const musicHash = sha256FileSync(track.path);
          if (!requestedVariantTrack && usedVariantMusic.has(musicHash)) throw new Error("VARIANT_MUSIC_SOURCE_DUPLICATE: choose distinct source music before mixing");
          usedVariantMusic.add(musicHash);
          deliveryInputPaths.push(track.path); rememberInputs("deliver", deliveryInputPaths);
        }
        const mixed = plan.output.replace(/\.mp4$/i, "-bgm.mp4");
        const mixArgs = ["--in", plan.output, "--out", mixed, "--policy", "keep-dialogue",
          "--music-level", String(-26 + plan.variant.musicLevelDeltaDb), "--ducking", "14", "--lufs", String(BGM_TARGET_LUFS), "--true-peak", arg("--bgm-true-peak", "-1.5"),
          "--section", "auto", "--bpm-strategy", "cut-driven", "--cut-times", CUT_GRID.join(","),
          "--evidence-dir", join(POST_DIR, "bgm-evidence", plan.variant.id)];
        if (track?.bpm) mixArgs.push("--bgm-bpm", String(track.bpm));
        const mix = track ? runCli(BGM_CLI, ["mix", ...mixArgs, "--bgm", track.path])
          : runCli(BGM_CLI, ["best", ...mixArgs, "--genre", plan.variant.bgmGenre, "--mood", plan.variant.bgmMood,
            "--source-policy", arg("--bgm-source-policy", "local-only")]);
        if (!mix.ok) throw new Error(`VARIANT_BGM_FAILED: ${mix.out.slice(-400)}`);
        inspectPostInput({ file: mixed, ffprobe: FFPROBE }); renameSync(mixed, plan.output);
        variantBgm = { track: track?.requested || `deterministic:${plan.variant.bgmGenre}:${plan.variant.bgmMood}`,
          sha256: track ? sha256FileSync(track.path) : fingerprintArtifact(plan.output).sha256 };
      }
      let variantCover: { path: string; sha256: string } | null = null;
      if (style) {
        verifyPresentationAsset(style.cover);
        const output = join(OUT_DIR, `${PROJECT}-cover-${plan.variant.id}.png`);
        copyFileSync(style.cover.path, output);
        variantCover = { path: output, sha256: sha256FileSync(output) };
      } else if (STAGES.has("cover") || existsSync(join(OUT_DIR, `${PROJECT}-cover.png`))) {
        const output = join(OUT_DIR, `${PROJECT}-cover-${plan.variant.id}.png`);
        const cover = await post.buildCover({ input: plan.output, output,
          project: { projectId: PROJECT, title: plan.coverCopy, platform: coverSpec.id }, variant: { id: plan.variant.id },
          resolution: [coverSpec.canvas.width, coverSpec.canvas.height], platform: coverSpec.id,
          bins: { ffmpeg: FFMPEG, ffprobe: FFPROBE }, workDir: join(POST_DIR, "variants", plan.variant.id) });
        variantCover = { path: cover.output, sha256: cover.sha256 };
      }
      let variantCoverIntro: { seconds: number; bodySha256: string; coverSha256: string } | undefined;
      if (!flag("--no-open-with-cover") && variantCover) {
        const intro = join(POST_DIR, `${plan.variant.id}-with-cover.mp4`);
        const receipt = prependFilmCover({ body: plan.output, cover: variantCover.path, output: intro,
          ffmpeg: FFMPEG, ffprobe: FFPROBE, fps: FPS, width: OUTPUT_SIZE.width, height: OUTPUT_SIZE.height,
          ...(style ? { music: style.bgm.path } : {}) });
        renameSync(intro, plan.output);
        variantCoverIntro = { seconds: receipt.introSeconds, bodySha256: receipt.body!.sha256, coverSha256: receipt.cover!.sha256 };
      }
      const info = inspectPostInput({ file: plan.output, ffprobe: FFPROBE });
      if (info.width !== OUTPUT_SIZE.width || info.height !== OUTPUT_SIZE.height) throw new Error(`VARIANT_EXPORT_DIMENSIONS_INVALID: ${plan.variant.id}`);
      variantManifest.push({ id: plan.variant.id, label: plan.variant.label, path: plan.output, sha256: info.sha256,
        note: plan.variant.note, gradeProfile: plan.variant.gradeProfile, width: info.width, height: info.height,
        cover: variantCover, bgm: variantBgm,
        ...(variantCoverIntro ? { coverIntro: variantCoverIntro } : {}),
        ...(style ? { title: style.title, fontName: style.fontName, fontSha256: style.font.sha256 } : {}) });
    } catch (error) {
      record({ stage: "deliver", shotId: null, invoked: true, ok: false, cached: false, degraded: false,
        attempt: 1, ms: Date.now() - started, artifact: null,
        evidence: { variant: plan.variant.id, error: error instanceof Error ? error.message : String(error), qualityReviewed: false }, verdict: null });
      throw error;
    }
  }
  if (PRESENTATION && !flag("--no-music") && usedVariantMusic.size !== variantPlans.length) {
    throw new Error("PRESENTATION_DELIVERY_INCOMPLETE: every requested style requires its own authored source music");
  }
  const gate = recordGate({ stepKey: "deliver", sourceStage: "deliver", checks: [
    { id: "master-resolution", pass: (() => { const info = probe(deliverablePath);
      return Number(info.width) === OUTPUT_SIZE.width && Number(info.height) === OUTPUT_SIZE.height; })(),
      hard: true, detail: `请求母版 ${OUTPUT_SIZE.width}x${OUTPUT_SIZE.height}` },
    { id: "variant-resolutions", pass: variantManifest.every(variant => variant.width === OUTPUT_SIZE.width && variant.height === OUTPUT_SIZE.height),
      hard: true, detail: "实际请求的变体导出尺寸" },
    { id: "variants-produced", pass: variantManifest.length === variantPlans.length, hard: true,
      detail: `请求 ${variantPlans.length}，实际 ${variantManifest.length}` },
  ], evidence: { variants: variantManifest, qualityReviewed: false, requestedVariantIds: variantPlans.map(plan => plan.variant.id) } });
  if (!gate.approved) throw new Error(`DELIVERY_EXPORT_FAILED: ${gate.reason}`);
  /** UHD sidecars join the same pending package; no public delivery file exists before G-DLV1. */
  const stagedSubtitles: string[] = [];
  if (QUALITY === "uhd" && subtitleSidecar) {
    const dir = join(OUT_DIR, "subtitles");
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(subtitleSidecar.dir)) {
      if (!/\.(srt|ass|vtt|json)$/i.test(name)) continue;
      const target = join(dir, name);
      copyFileSync(join(subtitleSidecar.dir, name), target);
      stagedSubtitles.push(target);
    }
  }
  const publishedVariants = variantManifest.map((variant) => ({
    ...variant,
    path: publicDeliveryPath(variant.path),
    cover: variant.cover ? { ...variant.cover, path: publicDeliveryPath(variant.cover.path) } : null,
  }));
  const coverFile = join(OUT_DIR, `${PROJECT}-cover.png`);
  const withCover = join(OUT_DIR, `${PROJECT}-with-cover.mp4`);
  /**
   * 渲染 / 返工台账（T-2026-0930-0015）：客户要能看到"**每一次花钱的账**"——几次提交、几次判不合格、
   * 几次平台拒收、几次 canary 止损、后期返工几次。清单与 Markdown 同时落盘（UHD 走暂存发布，一并纳入）。
   */
  const renderLedger = buildRenderLedger(readStageHistory());
  const renderLedgerFile = join(OUT_DIR, `${PROJECT}-render-ledger.md`);
  writeFileSync(renderLedgerFile, renderLedgerMarkdown(renderLedger), "utf8");
  const stagedContentAssets = [...new Set([deliverablePath, ...stagedSubtitles,
    ...variantManifest.flatMap((variant) => [variant.path, ...(variant.cover ? [variant.cover.path] : [])]),
    ...(existsSync(coverFile) ? [coverFile] : []),
    ...(softsubFile ? [softsubFile] : []),
    ...(existsSync(withCover) && stageApproved("cover-intro") ? [withCover] : []),
    renderLedgerFile,
  ])];
  const assetHashes = QUALITY === "uhd"
    ? await Promise.all(stagedContentAssets.map(async (path) => ({ path: publicDeliveryPath(path), sha256: await sha256UhdAsset(path) })))
    : stagedContentAssets.map((path) => ({ path: publicDeliveryPath(path), sha256: sha256FileSync(path) }));
  const manifestFile = join(OUT_DIR, `${PROJECT}-delivery-manifest.json`);
  writeFileSync(manifestFile, `${JSON.stringify({ ...buildDeliveryManifest({
    projectId: PROJECT,
    platform: arg("--platform", "抖音/快手"),
    /**
     * 键名必须是模块入参的小写 `deliverable`：批量改名（deliverable→DELIVERABLE）时别把**键**也改掉，
     * 否则这支主件会被 JSON.stringify 静默丢掉（真机 2026-09-25 踩过：清单里没有母版指纹）。
     */
    deliverable: {
      path: publicDeliveryPath(deliverablePath),
      sha256: QUALITY === "uhd" ? await sha256UhdAsset(deliverablePath) : sha256FileSync(deliverablePath),
      bytes: statSync(deliverablePath).size,
      durationSec: Number(probe(deliverablePath).duration ?? 0),
      namingAudit: auditDeliverableNaming({ path: deliverablePath, durationSec: Number(probe(deliverablePath).duration ?? 0) }),
    },
    subtitles: { sidecarDir: subtitleSidecar
        ? (QUALITY === "uhd" ? publicDeliveryPath(join(OUT_DIR, "subtitles")) : subtitleSidecar.dir)
        : null,
      softsub: softsubFile ? publicDeliveryPath(softsubFile) : null, burned: SUBTITLE_MODE !== "sidecar" },
    cover: { path: existsSync(join(OUT_DIR, `${PROJECT}-cover.png`)) ? publicDeliveryPath(join(OUT_DIR, `${PROJECT}-cover.png`)) : null, hook: arg("--cover-hook", shotlist.title ?? "") },
    variants: publishedVariants,
    distinctness,
    variantAxes,
    samples,
    at: stamp()
  }), assets: assetHashes, quality: {
    tier: QUALITY, sourceResolution: SOURCE_RESOLUTION, outputResolution: OUTPUT_RESOLUTION,
    width: OUTPUT_SIZE.width, height: OUTPUT_SIZE.height,
    localEnhancement: ENHANCE_ENGINE_DIR || flag("--enhance") ? "explicit request; receipt in stages.jsonl" : "requested FFmpeg scaling and padding; no model",
    qualityReviewed: false
  },
  /**
   * 交付口径留痕（T-2026-0930-0014）：审核层状态 + post-only 组装声明。
   * 客户侧应能一眼看到"哪些是既有素材复用、哪些事后检查被移除、质量由谁验收"。
   */
  reviewPolicy: REVIEW_POLICY,
  coverIntro: { embeddedInPrimary: coverIntroSeconds > 0, seconds: coverIntroSeconds, bodyFramesPreserved: true },
  durationObservation: observeFilmDuration(totalSeconds, Number(probe(deliverablePath).duration ?? 0), DURATION_POLICY),
  reviewPolicyNote: REVIEW_DISABLED_REASON,
  assembly: {
    mode: POST_ONLY_ASSEMBLY ? "post-only" : "generated",
    reason: POST_ONLY_REASON || null,
    shotReceiptsMissing: POST_ONLY_ASSEMBLY ? postOnlyMissingReceipts : [],
  },
  /**
   * 视频类型分流结论（T-2026-0930-0015）：审计能回答"这条片子按哪条管线做的、商品锚点是什么"。
   */
  route: {
    kind: ROUTE_PREFLIGHT.kind,
    source: ROUTE_PREFLIGHT.source,
    productAnchor: ROUTE_PREFLIGHT.productAnchor,
    notes: ROUTE_PREFLIGHT.notes,
  },
  /** 配乐层状态（T-2026-0930-0015）：off 时写明原因，不让"没配乐"变成查不到的黑盒 */
  bgm: bgmManifestInfo,
  /** 渲染/返工台账（次数与原因；不做费用估算） */
  renderLedger,
  renderLedgerFile: publicDeliveryPath(renderLedgerFile) }, null, 2)}\n`, "utf8");
  if (QUALITY === "uhd") {
    if (!gate.approved || gate.degraded) {
      record({ stage: "deliver", shotId: null, invoked: true, ok: false, cached: false, degraded: gate.degraded,
        attempt: 1, ms: Date.now() - started, artifact: manifestFile,
        evidence: { variants: variantManifest.map((v) => v.id), qualityReviewed: false, manifest: manifestFile },
        verdict: null, note: "G-DLV1 未放行，所有 UHD 文件只留在暂存区" });
      throw new Error(`UHD 交付包未放行（G-DLV1）：${gate.reason}`);
    }
    const stagedAssets = [...stagedContentAssets, manifestFile];
    rememberInputs("deliver", [...deliveryInputPaths, manifestFile, ...variantManifest.map((variant) => variant.path)]);
    try {
      const published = await publishUhdDelivery({
        stagingDir: OUT_DIR, publicRoot: PUBLIC_OUT_DIR, releaseId: RUN_ID,
        assets: stagedAssets.map((path) => relative(OUT_DIR, path)),
        manifestName: basename(manifestFile), approved: gate.approved && !gate.degraded,
      });
      const publishedManifest = publicDeliveryPath(manifestFile);
      record({ stage: "deliver", shotId: null, invoked: true, ok: true, cached: false, degraded: false,
        attempt: 1, ms: Date.now() - started, artifact: publishedManifest,
        evidence: { variants: variantManifest.map((v) => v.id), qualityReviewed: false,
          manifest: publishedManifest, files: published.files,
          outputFiles: stagedAssets.filter((path) => path !== manifestFile).map(publicDeliveryPath) },
        verdict: null, note: "G-DLV1 全绿后整包发布 UHD 交付目录" });
      log(`✅ UHD 交付包（G-DLV1 全绿）→ ${published.releaseDir}（${published.files} 个文件；当前指针 ${published.currentFile}）`);
    } catch (error) {
      record({ stage: "deliver", shotId: null, invoked: true, ok: false, cached: false, degraded: false,
        attempt: 1, ms: Date.now() - started, artifact: manifestFile,
        evidence: { publishError: error instanceof Error ? error.message : String(error) }, verdict: null,
        note: "UHD 交付发布失败，正式目录保留上一版" });
      throw error;
    }
  } else {
    record({
      stage: "deliver", shotId: null, invoked: true, ok: gate.approved, cached: false, degraded: gate.degraded, attempt: 1,
      ms: Date.now() - started, artifact: manifestFile,
      evidence: { variants: variantManifest.map((v) => v.id), qualityReviewed: false, manifest: manifestFile }, verdict: null, note: "实际请求的后期变体与文件清单；未做风格差异评审"
    });
    if (!gate.approved && !ACCEPT_REJECTED.includes("deliver")) {
      log(`⛔ 交付包未放行（G-DLV1）：${gate.reason}`);
      process.exit(6);
    }
  }
}

/* ---------- ⑬ 返修闭环（step_key: revise，gate G-DLV4：层增量 + 复用 sha256 证据） ---------- */
/**
 * 用法：`--stages revise --revise-note "SC-02 手部畸变，另外配乐换掉"`。
 * 行为：把返修意见分诊成 shot-level / layer-level / mixed，写出**影响分析 + 复用 sha256 证据**的返修报告，
 * 并给出可直接执行的 `--stages` 序列；**不自动重跑**（返修要花钱，交给人/上游决定执行）。
 */
if (STAGES.has("revise") && !DRY_RUN) {
  const note = arg("--revise-note", "");
  if (!note) {
    /**
     * 没有返修意见时**这是"不适用"，不是"失败"**（2026-09-25 修正）：
     * 早先记 `ok:false`，阶段汇总里会显示 `revise failed=1`，把"没触发"读成"跑挂了"。
     */
    record({
      stage: "revise", shotId: null, invoked: false, ok: true, cached: false, degraded: false, attempt: 1, ms: 0,
      artifact: null, evidence: { missing: "--revise-note", applicable: false }, verdict: null,
      note: "无返修意见（--revise-note 未提供）：本阶段不适用，未执行"
    });
  } else {
    const started = Date.now();
    const plan = buildRevisionPlan({
      note,
      shots: shots.map((shot) => ({ shotId: shot.shotId, clipPath: productionClipFile(shot.shotId) })),
      hasher: (file) => (existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : "missing")
    });
    const report = buildRevisionReport(plan, note);
    const reportFile = join(OUT_DIR, `${PROJECT}-revision-report.json`);
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    const gate = recordGate({
      stepKey: "revise",
      sourceStage: "revise",
      shotIds: plan.rerunShots,
      checks: [
        { id: "revision-classified", pass: plan.executable, hard: true, detail: report.gate.detail },
        { id: "reuse-evidence", pass: plan.blockers.every((blocker) => blocker.code !== "reuse_evidence_unavailable"), hard: true, detail: `复用镜头 ${plan.reuseEvidence.length} 个，均带 sha256 证据` },
        { id: "render-gate-awareness", pass: true, hard: false, detail: plan.requiresRenderSubmitGate ? "点名画面内容 → 重跑镜头并走 G8 提交审批" : "纯后期层 → 零渲染（镜头全部复用）" }
      ],
      evidence: { note, kind: plan.kind, stages: plan.stages, reuseEvidence: plan.reuseEvidence.map((e) => ({ shotId: e.shotId, sha256: e.sha256.slice(0, 16) })), report: reportFile }
    });
    record({
      stage: "revise", shotId: null, invoked: true, ok: gate.approved, cached: false, degraded: false, attempt: 1,
      ms: Date.now() - started, artifact: reportFile,
      evidence: { kind: plan.kind, layers: plan.layers, rerunShots: plan.rerunShots, stages: plan.stages, status: "planned" }, verdict: null,
      note: `返修影响分析（${plan.kind}）`
    });
    log(`返修报告：${reportFile}`);
    log(`  类型 ${plan.kind}｜重跑镜头 ${plan.rerunShots.join("/") || "无（零渲染）"}｜重做层 ${plan.layers.join(" → ") || "无"}`);
    for (const step of plan.executionSteps) log(`  执行步骤（${step.scope}）：--stages ${step.stages.join(",")}${step.scope === "selected-shots" ? ` --only ${step.shotIds.join(",")}` : ""}`);
    if (report.renderSubmitApproval.required) log("  渲染费用审批：G8 待核实，规划通过不授予付费权限");
    if (!plan.executable) process.exitCode = 6;
    else if (flag("--execute-revision")) {
      const execution = await executeRevision({
        note,
        shots: shotlist.shots.map((shot) => ({ shotId: shot.shotId, clipPath: productionClipFile(shot.shotId) })),
        onStep: async (step, index) => {
          const originalArgs = process.argv.slice(2);
          const childArgs: string[] = [];
          const removeValue = new Set(["--stages", "--only", "--revise-note", "--revision-context"]);
          for (let i = 0; i < originalArgs.length; i++) {
            if (removeValue.has(originalArgs[i]!)) { i += 1; continue; }
            if (originalArgs[i] === "--execute-revision") continue;
            childArgs.push(originalArgs[i]!);
          }
          childArgs.push("--stages", step.stages.join(","), "--revision-context", note);
          if (step.scope === "selected-shots") childArgs.push("--only", step.shotIds.join(","), "--no-resume");
          const result = spawnSync(process.execPath, ["--import", "tsx", join(REPO_ROOT, "scripts/tools/full-chain-film.mts"), ...childArgs], {
            cwd: REPO_ROOT, env: process.env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
            timeout: Number(arg("--revision-timeout-ms", "2700000"))
          });
          const logFile = join(LOG_DIR, `revision-${RUN_ID}-step-${index + 1}.log`);
          writeFileSync(logFile, `${result.stdout ?? ""}\n${result.stderr ?? ""}`, "utf8");
          return { exitCode: result.status, detail: result.error ? result.error.message : `退出 ${result.status}，工位日志 ${logFile}` };
        }
      });
      const executionFile = join(OUT_DIR, `${PROJECT}-revision-execution.json`);
      writeFileSync(executionFile, `${JSON.stringify(execution, null, 2)}\n`, "utf8");
      record({
        stage: "revise", shotId: null, invoked: true, ok: execution.status === "completed", cached: false,
        degraded: execution.status === "unverified", attempt: 1, ms: Date.now() - started, artifact: executionFile,
        evidence: { status: execution.status, steps: execution.steps, reused: execution.reused, errors: execution.errors }, verdict: null,
        note: "按登记工位顺序执行；逐镜和整片步骤分离；未选镜头每步前后核对真实字节"
      });
      if (execution.status !== "completed") process.exitCode = 6;
    }
  }
}

/* ---------- 收尾：阶段汇总落盘 ---------- */
const byStage = new Map<string, { invoked: number; ok: number; failed: number; degraded: number; cached: number }>();
for (const r of records) {
  const cur = byStage.get(r.stage) ?? { invoked: 0, ok: 0, failed: 0, degraded: 0, cached: 0 };
  if (r.invoked) cur.invoked += 1;
  if (r.ok) cur.ok += 1; else if (r.invoked) cur.failed += 1;
  if (r.degraded) cur.degraded += 1;
  if (r.cached) cur.cached += 1;
  byStage.set(r.stage, cur);
}
writeFileSync(join(LOG_DIR, "stage-summary.json"), `${JSON.stringify({
  project: PROJECT, at: stamp(), shots: shots.length, totalSeconds,
  stages: Object.fromEntries(byStage), records
}, null, 2)}\n`, "utf8");
log(`阶段日志：${STAGE_LOG}`);
for (const [stage, s] of byStage) log(`  · ${stage.padEnd(14)} invoked=${s.invoked} ok=${s.ok} failed=${s.failed} degraded=${s.degraded} cached=${s.cached}`);

if (!DRY_RUN) {
  const aliases: Record<string, string[]> = { spec: ["prompt-review", "prompt-package"], plates: ["keyframe"], videos: ["shot"], "material-gen": ["material-gen"], "identity-check": ["render-source"], voice: ["voice"], continuity: ["continuity"] };
  const notApplicable = (stage: string): boolean =>
    (stage === "material-gen" && materialShots().length === 0)
    || (stage === "mux" && SUBTITLE_MODE === "burn")
    || (stage === "danmaku" && !DANMAKU_ENABLED);
  const missing = [...STAGES].filter((stage) => !notApplicable(stage) && !(aliases[stage] ?? [stage]).some((alias) => records.some((row) => row.stage === alias)));
  const latest = new Map<string, StageRecord>();
  for (const row of records) latest.set(`${lineageStage(row)}:${row.shotId ?? ""}`, row);
  const failed = [...latest.values()].filter((row) => (row.invoked || STAGES.has(row.stage)) && (!row.ok || row.degraded || row.verdict?.approved === false));
  /**
   * post-only 组装（T-2026-0929-0012）与"咨询项不阻断交付"（T-2026-0930-0014）：
   * 已**显式声明**的降级（evidence.assemblyMode=post-only）与咨询性结论不再算作"请求未完成"——
   * 它们的含义是"源素材是既有成品片段/某项创作口径未命中"，不是"产物没做出来"。
   * 未声明的失败照旧 exit 6，避免真实故障被混在声明里蒙混过关。
   */
  const declaredPostOnly = (row: StageRecord): boolean =>
    row.degraded && (row.evidence as { assemblyMode?: unknown } | undefined)?.assemblyMode === "post-only";
  const declared = failed.filter((row) => declaredPostOnly(row));
  const hardFailed = failed.filter((row) => !declaredPostOnly(row));
  if (missing.length || hardFailed.length) {
    log(`⛔ 请求未完成：缺阶段 ${missing.join("/") || "无"}；未通过 ${hardFailed.map((row) => row.stage + (row.shotId ? `:${row.shotId}` : "")).join("/") || "无"}`);
    process.exitCode = 6;
  } else if (declared.length > 0) {
    log(`⚠ 带声明降级完成（post-only 组装）：${declared.map((row) => row.stage + (row.shotId ? `:${row.shotId}` : "")).join("/")}`
      + "——降级项已留痕在阶段日志与交付清单（assemblyMode=post-only），后期链与交付物均已产出。");
  }
}
if (WORKER_RUNTIME) WORKER_RUNTIME.finish(records, !process.exitCode);
