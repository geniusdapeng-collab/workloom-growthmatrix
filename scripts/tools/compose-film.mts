#!/usr/bin/env tsx
/**
 * 成片拼接工具（2026-09-21）——逐镜产物 → 一条竖版母版（可选标题/字幕 + 调色）。
 *
 * 为什么需要：较长作品由模型能力范围内的多个完整镜头拼接；
 * 逐镜产物的编码参数（分辨率/帧率/音轨）各自不同，直接 concat 会花屏/丢音。
 *
 * 三段式（每段都可单独复跑）：
 *   ① 归一化：逐镜 → 统一 WxH / fps / yuv420p / AAC 48k 立体声（临时目录）
 *   ② 拼接：concat demuxer -c copy（归一化后参数一致，可无损拼接）
 *   ③ 收口：淡入淡出 + 标题/字幕烧字（可选）→ 母版
 *   ④ 调色：走调色工位**择优**（color-bridge `best`：候选生成 + 画质打分 + 不劣化优先），
 *      可用 `--recipe <题材配方 id>` 把题材配方作为候选之一；判定"无需调色"时不产出调色版
 *
 * 用法：
 *   pnpm exec tsx scripts/tools/compose-film.mts \
 *     --clips a.mp4,b.mp4,... --out outputs/nanyuan-master-30s.mp4 \
 *     [--width 1080 --height 1920 --fps 30] [--fade 0.5] \
 *     [--title "苏州南园宾馆"] [--subtitle "唯一可以入住的苏州园林"] \
 *     --recipe real-estate [--min-improvement 2] [--graded-out outputs/nanyuan-graded-30s.mp4] \
 *     [--keep-temp] [--json]
 */
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  avSyncPolicyForClipCount,
  candidateSyncWindows,
  crossCorrelationLag,
  describeAvSync,
  evaluateAvSync,
  type AvSyncSample,
} from "../../packages/video-studio/src/av-sync.js";
import { filmReviewPolicy, renderedAcceptanceReceipt } from "../../packages/video-studio/src/rendered-output-policy.js";
import { assertPreservedSourceTiming, endCardSeconds, parseClipTailHolds } from "../../packages/video-studio/src/film-post-options.js";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const FFMPEG = process.env.WL_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.WL_FFPROBE ?? "ffprobe";
const FONT_FILE = process.env.WL_FONT_FILE ?? "/System/Library/Fonts/STHeiti Medium.ttc";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
const flag = (name: string) => process.argv.includes(name);
const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));

function run(bin: string, args: string[], env?: NodeJS.ProcessEnv): string {
  try {
    return execFileSync(bin, args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      ...(env ? { env } : {}),
    });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(`${bin} 失败：${(e.stderr ?? e.message ?? "").toString().slice(-800)}`);
  }
}

/**
 * 整轨解码为 PCM（f32le 单声道）——音画对齐实测用。
 * 为什么整轨解码而不是 `-ss` 抽窗口：aac 一帧 1024 样点，局部 seek 的落点会带
 * 0–21ms 的量化误差，用它判"偏移"会自己骗自己（实测会伪造出单调漂移）。
 */
function readAllPcm(file: string, sampleRate: number): Float32Array {
  const buf = execFileSync(
    FFMPEG,
    ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(sampleRate), "-f", "f32le", "-"],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const view = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  return view.slice();
}

async function sha256File(file: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

export function probeDuration(file: string): number {
  const out = run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).trim();
  return Number(out) || 0;
}

const clipsArg = arg("--clips");
if (!clipsArg) throw new Error("需要 --clips a.mp4,b.mp4（按成片顺序）");
const clips = clipsArg.split(",").map((c) => abs(c.trim())).filter(Boolean);
const shotIds = arg("--shot-ids").split(",").map(value => value.trim()).filter(Boolean);
if (shotIds.length && (shotIds.length !== clips.length || new Set(shotIds).size !== shotIds.length)) throw new Error("COMPOSE_SHOT_SCOPE_INVALID");
const clipTailHolds = parseClipTailHolds(arg("--clip-tail-holds"), clips.length);
for (const clip of clips) {
  if (!existsSync(clip)) throw new Error(`镜头产物不存在：${clip}`);
}
const out = abs(arg("--out", "outputs/film-master.mp4"));
const width = Number(arg("--width", "1080"));
const height = Number(arg("--height", "1920"));
const fps = Number(arg("--fps", "30"));
const reviewPolicy = filmReviewPolicy(arg("--review-policy", "off"));
const fade = Number(arg("--fade", "0.5"));
/** Legacy overlap and retime arguments are checked before writing any output. Source shots keep their full duration. */
const transition = arg("--transition");
const transitionDuration = Number(arg("--transition-duration", "0"));
const retimeTo = Number(arg("--retime-to", "0"));
assertPreservedSourceTiming({ retimeTo, transition, transitionDuration });
const endCardImage = arg("--end-card-image") ? abs(arg("--end-card-image")) : "";
const endCardDuration = endCardSeconds(endCardImage, arg("--end-card-seconds"));
if (endCardImage && !existsSync(endCardImage)) throw new Error("END_CARD_IMAGE_MISSING");
const title = arg("--title");
const subtitle = arg("--subtitle");
/**
 * 调色模式（2026-09-22 修正）：
 *   best（默认）= 走 color-bridge 的「择优」：候选生成 + 画质打分 + 允许不调（不劣化优先）；
 *   grade       = 旧口径（固定 profile/LUT/intensity），仅兼容历史调用；
 *   none        = 不调色。
 * 事故背景：旧实现固定 `clean-bright@0.55 + auto`，绕过了择优闸门；按产品自己的画质分，
 * 该结果对母版是**劣化**（score 91.99：饱和×0.79、细节×0.92、亮度漂移 +39.6）。
 */
const colorMode = arg("--color", "best");
const recipeId = arg("--recipe");
const minImprovement = Number(arg("--min-improvement", "2"));
const gradeProfile = arg("--grade-profile");
const gradeLut = arg("--grade-lut");
const gradeIntensity = arg("--grade-intensity", "0.55");
const gradedOut = arg("--graded-out");

mkdirSync(dirname(out), { recursive: true });
const temp = mkdtempSync(join(tmpdir(), "wl-compose-"));
console.log(`拼接 ${clips.length} 个镜头 → ${width}x${height} @${fps}fps（临时目录 ${temp}）`);
const sourceTiming = await Promise.all(clips.map(async (path, index) => ({ path, ...(shotIds.length ? { shotId: shotIds[index] } : {}), sha256: await sha256File(path),
  videoSeconds: Number(run(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=duration", "-of", "csv=p=0", path]).trim()) })));
if (sourceTiming.some(row => !Number.isFinite(row.videoSeconds) || row.videoSeconds <= 0)) throw new Error("SOURCE_VIDEO_DURATION_UNVERIFIED");
if (endCardImage) {
  const card = join(temp, "end-card.mp4");
  run(FFMPEG, ["-v", "error", "-y", "-loop", "1", "-framerate", String(fps), "-i", endCardImage,
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", String(endCardDuration),
    "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`,
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", card]);
  clips.push(card);
  clipTailHolds.push(0);
  console.log(`  独立后期引导卡 ${endCardDuration}s；不冻结、不变速、不裁短源镜头`);
}

/* ---------- ① 归一化 ---------- */
const normalized: string[] = [];
clips.forEach((clip, index) => {
  const target = join(temp, `norm-${String(index).padStart(2, "0")}.mp4`);
  /**
   * 每段音轨必须与画面**等长**（2026-09-26 真机事故修复）：
   * aac 编码器 priming + 帧对齐会让音轨流比画面短十几毫秒，逐段累计后
   * 拼接出来的音轨时间轴会整体提前（真机：5 镜时第 3 镜就偏 -145ms）。
   * 因此归一化时用 `apad` 把声音补到画面时长（补的是静音，≤20ms，听不出来），
   * 下游无论走 concat 滤镜还是 demuxer，时间轴都不会再漂。
   */
  const videoSeconds = sourceTiming[index]?.videoSeconds ?? endCardDuration;
  const inFrames = Math.max(1, Math.round(videoSeconds * fps));
  const targetDuration = inFrames / fps;
  run(FFMPEG, [
    "-y", "-i", clip,
    "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps}`,
    "-af", "apad",
    "-t", targetDuration.toFixed(6),
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart", target,
  ]);
  const streamDurations = run(FFPROBE, [
    "-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "csv=p=0", target,
  ]).trim().split("\n").map((line) => line.split(","));
  const targetVideo = Number(streamDurations.find((row) => row[0] === "video")?.[1] ?? 0);
  const targetAudio = Number(streamDurations.find((row) => row[0] === "audio")?.[1] ?? 0);
  const avDelta = Math.abs(targetVideo - targetAudio);
  normalized.push(target);
  console.log(`  ① 归一化 ${basename(clip)} → ${targetVideo.toFixed(2)}s（音轨 ${targetAudio.toFixed(2)}s，Δ${(avDelta * 1000).toFixed(0)}ms）`);
  if (avDelta > 0.01) {
    console.log(`       ⚠ 该段音画长度差 ${(avDelta * 1000).toFixed(0)}ms > 10ms，拼接前请确认（对齐自检会再实测一次）`);
  }
});
for (const source of sourceTiming) if (await sha256File(source.path) !== source.sha256) throw new Error("SOURCE_CHANGED_DURING_COMPOSE");

/* ---------- ② 拼接 ---------- */
const raw = join(temp, "raw.mp4");
/**
 * 每段**按画面时长**把音轨切/补到精确长度（2026-09-26 真机事故修复的关键一步）：
 * aac 把音频按 1024 样点（48k 下 21.33ms）成帧，末帧向上取整，
 * 于是每段音轨比画面**长** 0–21ms；不透支这个差，逐段累计就是 33ms/6 镜的漂移。
 * 不变量：每段音轨时长 === 该段画面时长（D = 帧数 / fps）。
 */
const shotFrames = normalized.map((file) => {
  const out = run(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-count_frames",
    "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file]).trim();
  const frames = Number(out);
  return Number.isFinite(frames) && frames > 0 ? frames : Math.round(probeDuration(file) * fps);
});
const shotSeconds = shotFrames.map((frames) => frames / fps);
/**
 * concat demuxer 缺省用 MP4 容器时长移动下一镜的 PTS。AAC 帧尾可能令容器比
 * 视频轨多出数毫秒，即使只拷视频也会在镜头接缝留下非整帧间隔。每镜用同一份
 * 帧数/fps 时长覆盖容器时长；下方音轨切补和音画实测也必须共用 shotSeconds。
 */
const listFile = join(temp, "concat.txt");
writeFileSync(listFile, normalized.map((file, index) =>
  `file '${file}'\nduration ${shotSeconds[index]!.toFixed(6)}`).join("\n"), "utf8");
const audioExact = normalized.map((_, index) =>
  `[${index}:a]atrim=end=${shotSeconds[index]!.toFixed(6)},asetpts=N/SR/TB,`
  + `apad=whole_dur=${shotSeconds[index]!.toFixed(6)}[aex${index}]`);
/**
 * 硬切拼接的**音画对齐纪律**（2026-09-26 真机事故修复）：
 * 逐段 mp4 里 aac 音轨普遍比画面短几毫秒（编码器 priming + 帧对齐），
 * `-f concat -c copy` 会让 demuxer **按各自流的时长**分别累计偏移 →
 * 声音相对画面逐镜漂移（真机实测 15 镜尾镜 +125ms，听感="上一镜的音效串到下一镜"）。
 * 现在：画面仍无损直拷（帧级不重编码），声音改走 **concat 滤镜**（样点级顺序拼接、
 * 不足处按画面时长补静音），再与画面合流。代价只有一次音频重编码。
 */
const videoOnly = join(temp, "video-only.mp4");
run(FFMPEG, ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c:v", "copy", "-an", videoOnly]);
const voiceWav = join(temp, "voice.wav");
const audioInputs = normalized.flatMap((file) => ["-i", file]);
const audioConcat = `${normalized.map((_, index) => `[aex${index}]`).join("")}concat=n=${normalized.length}:v=0:a=1[aout]`;
run(FFMPEG, [
  "-y", ...audioInputs,
  "-filter_complex", [...audioExact, audioConcat].join(";"),
  "-map", "[aout]", "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", voiceWav,
]);
run(FFMPEG, [
  "-y", "-i", videoOnly, "-i", voiceWav,
  "-map", "0:v:0", "-map", "1:a:0",
  "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
  "-shortest", "-movflags", "+faststart", raw,
]);
const rawDuration = probeDuration(raw);
console.log(`  ② 拼接完成 → ${rawDuration.toFixed(2)}s`);

/* ---------- ③ 收口（淡入淡出 + 标题/字幕烧字） ---------- */
const filters: string[] = [];
if (fade > 0) {
  filters.push(`fade=t=in:st=0:d=${fade}`, `fade=t=out:st=${Math.max(0, rawDuration - fade).toFixed(2)}:d=${fade}`);
}
const fontOpts = existsSync(FONT_FILE) ? `fontfile='${FONT_FILE}':` : "";
if (title) {
  const titleFile = join(temp, "title.txt");
  writeFileSync(titleFile, title, "utf8");
  filters.push(
    `drawtext=${fontOpts}textfile='${titleFile}':fontcolor=white:fontsize=${Math.round(width * 0.062)}:`
    + `x=(w-text_w)/2:y=h*0.09:box=1:boxcolor=black@0.35:boxborderw=${Math.round(width * 0.018)}:`
    + `enable='between(t,${fade},${Math.min(rawDuration, fade + 4).toFixed(2)})'`
  );
}
if (subtitle) {
  const subFile = join(temp, "subtitle.txt");
  writeFileSync(subFile, subtitle, "utf8");
  filters.push(
    `drawtext=${fontOpts}textfile='${subFile}':fontcolor=white:fontsize=${Math.round(width * 0.036)}:`
    + `x=(w-text_w)/2:y=h*0.86:box=1:boxcolor=black@0.35:boxborderw=${Math.round(width * 0.012)}:`
    + `enable='between(t,${fade},${Math.min(rawDuration, fade + 4).toFixed(2)})'`
  );
}
const retimeFactor = 1;
run(FFMPEG, [
  "-y", "-i", raw,
  ...(filters.length > 0 ? ["-vf", filters.join(",")] : []),
  "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out,
]);
const outDuration = probeDuration(out);
console.log(`  ③ 母版 → ${out}（${outDuration.toFixed(2)}s）`);

/* ---------- ③-1 音画对齐实测（机制，不是建议） ---------- */
/**
 * 为什么必修：2026-09-26 真机事故——分段拼接时声音逐镜累计漂移，尾镜 +125ms，
 * 成片里表现为"上一镜的音效/台词落到下一镜"。只靠"参数写对"是不够的：
 * 编码器 priming、帧对齐、重采样都会让每段的音轨比画面短几毫秒，
 * 所以**拼完必须实测**，并按门禁口径判能不能出厂。
 */
const avSyncSampleRate = 16000;
const shotDurations = shotSeconds;
const shotStarts: number[] = [];
{
  let cursor = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    shotStarts.push(cursor);
    if (index < normalized.length - 1) {
      cursor += shotDurations[index]!;
    }
  }
}
const masterPcm = readAllPcm(out, avSyncSampleRate);
const searchMs = 300;
const searchSamples = Math.round((searchMs / 1000) * avSyncSampleRate);
const avSamples: AvSyncSample[] = [];
for (let index = 0; index < normalized.length; index += 1) {
  const duration = shotDurations[index]!;
  /**
   * **窗口择优**（2026-09-27 真机）：单一固定窗口落在停顿/环境声上时，互相关会锁到邻近镜的
   * 相似内容（真机：GR-06 固定窗口相关性 0.439、报出 -573.6ms 假偏移，硬闸误判；同一素材
   * 整段包络互相关 0.995、位置正好等于期望值）。同一镜试多个候选窗口，取相关性最高者——
   * 相关性仍低于阈值就按"不可测"处理，判据不放宽，只是不再拿一个坏窗口给整镜定罪。
   */
  const windows = candidateSyncWindows({ durationSec: duration });
  if (windows.length === 0) continue;
  const winLen = windows[0]!.lengthSec;
  const segmentPcm = readAllPcm(normalized[index]!, avSyncSampleRate);
  const refFull = segmentPcm;
  const refLen = Math.round(winLen * avSyncSampleRate);
  let best: { lagMs: number; correlation: number } | null = null;
  for (const { startSec: winStart } of windows) {
    const refStart = Math.round(winStart * avSyncSampleRate);
    if (refStart + refLen > refFull.length) continue;
    const ref = refFull.subarray(refStart, refStart + refLen);
    const expected = Math.round((shotStarts[index]! + winStart) * avSyncSampleRate);
    const targetStart = Math.max(0, expected - searchSamples);
    const targetEnd = Math.min(masterPcm.length, expected + refLen + searchSamples);
    const target = masterPcm.subarray(targetStart, targetEnd);
    if (target.length < refLen + 32) continue;
    const measured = crossCorrelationLag(ref, target, {
      sampleRate: avSyncSampleRate,
      maxLagMs: searchMs,
    });
    const trueLagMs = measured.lagMs - (expected - targetStart) / avSyncSampleRate * 1000;
    if (!best || measured.correlation > best.correlation) {
      best = { lagMs: trueLagMs, correlation: measured.correlation };
    }
  }
  if (!best) continue;
  avSamples.push({
    shotId: `#${index + 1}`,
    index,
    lagMs: Number(best.lagMs.toFixed(2)),
    correlation: Number(best.correlation.toFixed(3)),
  });
}
const avPolicy = avSyncPolicyForClipCount(normalized.length);
const avReport = evaluateAvSync(avSamples, avPolicy);
const avReportPath = join(dirname(out), `${basename(out).replace(/\.mp4$/i, "")}.av-sync.json`);
writeFileSync(avReportPath, `${JSON.stringify({
  ...avReport,
  generatedAt: new Date().toISOString(),
  policy: avPolicy,
  sampleRate: avSyncSampleRate,
  clipCount: normalized.length,
  clipTailHolds,
  sourceTiming,
  normalizedTimeline: sourceTiming.map((source, index) => ({ ...source, composedSeconds: shotSeconds[index],
    frameQuantizationSeconds: Number((shotSeconds[index]! - source.videoSeconds).toFixed(6)), speedFactor: 1 })),
  sourceTimingPolicy: "original speed and complete video timeline; only encoding/frame-rate quantization within one frame",
  independentEndCard: endCardImage ? { image: endCardImage, sha256: await sha256File(endCardImage), seconds: endCardDuration } : null,
  retimeFactor,
  output: out,
  outputSha256: await sha256File(out),
  reviewPolicy,
  ...(reviewPolicy === "off" ? renderedAcceptanceReceipt(reviewPolicy) : {}),
}, null, 2)}\n`, "utf8");
console.log(`  ③-1 ${describeAvSync(avReport)}`);
console.log(`       报告：${avReportPath}`);
if (avReport.warnings.length > 0) {
  for (const warning of avReport.warnings) console.log(`       ⚠ ${warning}`);
}
if (!avReport.ok && reviewPolicy === "blocking" && !flag("--accept-av-sync-drift")) {
  throw new Error(
    `音画对齐实测不通过：${avReport.violations.join("；")}。`
    + `报告见 ${avReportPath}；确属客观条件必须放行时，显式加 --accept-av-sync-drift 并留痕。`,
  );
}
if (!avReport.ok) {
  console.log(reviewPolicy === "blocking"
    ? "       ⚠ 已按 --accept-av-sync-drift 显式放行，实测失败保留在报告"
    : `       ⓘ ${reviewPolicy}：实测结果仅供查看，不阻断后期；未把实测失败改成通过`);
}

/* ---------- ④ 调色：择优（不劣化优先） ---------- */
let gradedPath: string | null = null;
let colorReport: Record<string, unknown> | null = null;
if (colorMode !== "none") {
  const cli = resolve(REPO_ROOT, "bundles/ai-video/connectors/color-bridge/cli.mjs");
  const coreUrl = pathToFileURL(resolve(REPO_ROOT, "bundles/ai-video/connectors/color-bridge/core.mjs")).href;
  const target = abs(gradedOut || out.replace(/\.mp4$/i, "-graded.mp4"));
  /**
   * 调色工位有"路径监狱"（core.mjs assertPathAllowed）：只放行 WORKLOOM_COLOR_ALLOWED_ROOTS
   * 内的路径（缺省进程工作目录 + 系统临时目录）。成片若落在别处必须显式放行，
   * 否则 grade 直接 path_not_allowed（真机 2026-09-21 实测）。
   */
  const roots = [dirname(out), dirname(target), REPO_ROOT, tmpdir()].join(":");
  const colorEnv = { ...process.env, WORKLOOM_COLOR_ALLOWED_ROOTS: roots };

  /** 题材配方 → 候选（bundles/ai-video/library/color-recipes/recipes.json 为唯一真源） */
  function recipeCandidates(): Array<Record<string, unknown>> {
    if (!recipeId) return [];
    const recipesPath = resolve(REPO_ROOT, "bundles/ai-video/library/color-recipes/recipes.json");
    const doc = JSON.parse(readFileSync(recipesPath, "utf8")) as {
      recipes: Array<{ id: string; genre: string; profile: string; lut?: string | null; intensity: number }>;
    };
    const recipe = doc.recipes.find((r) => r.id === recipeId || r.genre === recipeId);
    if (!recipe) throw new Error(`题材配方不存在：${recipeId}（见 ${recipesPath.replace(REPO_ROOT + "/", "")}）`);
    const lutPath = recipe.lut ? resolve(REPO_ROOT, "bundles/ai-video/library/luts", recipe.lut) : null;
    const base = { profile: recipe.profile, lutPath, corrections: {} };
    return [
      { id: `${recipe.id}@${recipe.intensity}`, label: `${recipe.genre} 配方`, spec: { ...base, intensity: recipe.intensity } },
      { id: `${recipe.profile}@0.4`, label: `${recipe.profile} 强度 0.4`, spec: { profile: recipe.profile, lutPath, corrections: {}, intensity: 0.4 } },
      { id: `${recipe.profile}@0.7`, label: `${recipe.profile} 强度 0.7`, spec: { profile: recipe.profile, lutPath, corrections: {}, intensity: 0.7 } }
    ];
  }

  if (colorMode === "grade") {
    console.log(`  ④ 调色（旧口径 grade）：${gradeProfile} @${gradeIntensity} → ${target}`);
    const result = run(process.execPath, [
      cli, "grade", "--in", out, "--out", target,
      "--profile", gradeProfile, "--intensity", gradeIntensity, "--auto",
      ...(gradeLut ? ["--lut", abs(gradeLut)] : []), "--json"
    ], colorEnv);
    gradedPath = target;
    colorReport = JSON.parse(result.trim()) as Record<string, unknown>;
  } else {
    const core = await import(coreUrl) as {
      best(input: Record<string, unknown>): Promise<Record<string, unknown>>;
      resolveBinaries(): unknown;
    };
    const candidates = recipeCandidates();
    console.log(
      `  ④ 调色（择优 best）：${candidates.length ? `题材配方候选 ${candidates.length} 个 + 内置候选` : "内置候选（identity/auto-correct/8 profiles × 2 强度）"}`
      + `，阈值 +${minImprovement} 分`
    );
    const verdict = await core.best({
      input: out,
      output: target,
      minImprovement,
      bins: core.resolveBinaries(),
      ...(candidates.length ? { candidates } : {})
    });
    colorReport = verdict;
    const table = (verdict.candidates as Array<Record<string, unknown>> | undefined) ?? [];
    for (const candidate of [...table].sort((a, b) => Number(b.score) - Number(a.score)).slice(0, 6)) {
      const reasons = (candidate.reasons ?? {}) as Record<string, unknown>;
      console.log(
        `     ${String(Number(candidate.score).toFixed(2)).padStart(7)}  ${String(candidate.id).padEnd(22)}`
        + ` 对比度×${reasons.contrastRatio} 饱和×${reasons.satRatio} 裁切${reasons.clipDeltaPct}% 亮度${reasons.lumaDrift}`
      );
    }
    if (verdict.verdict === "graded") {
      gradedPath = target;
      const visibility = (verdict.visibility ?? {}) as Record<string, unknown>;
      console.log(
        `     判定：调色（winner=${String(verdict.winner)}，较母版 +${String(verdict.improvement)} 分，`
        + `可见性 ${String(visibility.meanAbsDiff ?? "?")}/255 ${String(visibility.verdict ?? "")}）`
      );
    } else {
      console.log(`     判定：无需调色（不劣化优先）——${String(verdict.reason ?? "")}`);
      console.log("     母版即为交付版本，未产出调色文件");
    }
  }

  const reportPath = join(dirname(out), `${basename(out).replace(/\.mp4$/i, "")}-color-report.json`);
  writeFileSync(reportPath, `${JSON.stringify({ mode: colorMode, recipe: recipeId ?? null, report: colorReport }, null, 2)}\n`, "utf8");
  console.log(`     调色报告：${reportPath}`);
}

if (!flag("--keep-temp")) rmSync(temp, { recursive: true, force: true });

const summary = {
  clips: clips.length,
  width, height, fps,
  master: out,
  masterSeconds: Number(outDuration.toFixed(3)),
  graded: gradedPath,
  color: colorReport ? { mode: colorMode, verdict: colorReport.verdict ?? "grade", winner: colorReport.winner ?? gradeProfile ?? null } : null
};
if (flag("--json")) console.log(`COMPOSE ${JSON.stringify(summary)}`);
else console.log(`成片：${out}（${outDuration.toFixed(2)}s${gradedPath ? `；调色版 ${gradedPath}` : ""}）`);
