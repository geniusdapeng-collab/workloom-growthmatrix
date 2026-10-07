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
 *   ④ 调色：默认不调；明确提供 profile/LUT/recipe 时执行该请求一次，另存调色版。
 *      不运行源片画质打分、候选择优、音画相关性或失败后的质量重试。
 *
 * 用法：
 *   pnpm exec tsx scripts/tools/compose-film.mts \
 *     --clips a.mp4,b.mp4,... --out outputs/nanyuan-master-30s.mp4 \
 *     [--width 1080 --height 1920 --fps 30] [--fade 0.5] \
 *     [--title "苏州南园宾馆"] [--subtitle "唯一可以入住的苏州园林"] \
 *     --recipe real-estate [--graded-out outputs/nanyuan-graded-30s.mp4] \
 *     [--keep-temp] [--json]
 */
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { inspectPostInput, POST_RENDER_ACCEPTANCE_POLICY } from "../../packages/video-studio/src/post-render-acceptance.js";
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
for (const clip of clips) {
  if (!existsSync(clip)) throw new Error(`镜头产物不存在：${clip}`);
}
const out = abs(arg("--out", "outputs/film-master.mp4"));
const width = Number(arg("--width", "1080"));
const height = Number(arg("--height", "1920"));
const fps = Number(arg("--fps", "30"));
const fade = Number(arg("--fade", "0.5"));
if (![width, height, fps].every(value => Number.isInteger(value) && value > 0) || !Number.isFinite(fade) || fade < 0) {
  throw new Error("COMPOSE_EXPORT_OPTIONS_INVALID");
}
const clipTailHolds = parseClipTailHolds(arg("--clip-tail-holds"), clips.length);
const shotIds = arg("--shot-ids").split(",").map(value => value.trim()).filter(Boolean);
if (shotIds.length && (shotIds.length !== clips.length || new Set(shotIds).size !== shotIds.length)) throw new Error("COMPOSE_SHOT_IDS_INVALID");
/** Timing protection is checked before output creation; transitions may use separate authored segments. */
const transition = arg("--transition");
const transitionDuration = Number(arg("--transition-duration", "0"));
const retimeTo = Number(arg("--retime-to", "0"));
assertPreservedSourceTiming({ retimeTo, transition, transitionDuration });
const endCardImage = arg("--end-card-image") ? abs(arg("--end-card-image")) : "";
const endCardDuration = endCardSeconds(endCardImage, arg("--end-card-seconds"));
if (endCardImage && !existsSync(endCardImage)) throw new Error("END_CARD_IMAGE_MISSING");
const title = arg("--title");
const subtitle = arg("--subtitle");
/** 调色为明确请求的后期加工；none 默认，grade/best 均按给定配方执行一次。 */
const colorMode = arg("--color", arg("--recipe") || arg("--grade-profile") || arg("--grade-lut") ? "grade" : "none");
if (!["none", "grade", "best"].includes(colorMode)) throw new Error(`未知调色方式：${colorMode}`);
const recipeId = arg("--recipe");
const gradeProfile = arg("--grade-profile");
const gradeLut = arg("--grade-lut");
const gradeIntensity = arg("--grade-intensity", "0.55");
const gradedOut = arg("--graded-out");

mkdirSync(dirname(out), { recursive: true });
const temp = mkdtempSync(join(tmpdir(), "wl-compose-"));
console.log(`拼接 ${clips.length} 个镜头 → ${width}x${height} @${fps}fps（临时目录 ${temp}）`);

/* ---------- ① 归一化 ---------- */
const normalized: string[] = [];
const sourceReceipts = clips.map(file => inspectPostInput({ file, ffprobe: FFPROBE }));
const sourceTiming = sourceReceipts.map((source, index) => ({ path: source.path,
  ...(shotIds.length ? { shotId: shotIds[index] } : {}), sha256: source.sha256, videoSeconds: source.durationSec }));
if (endCardImage) {
  const card = join(temp, "end-card.mp4");
  run(FFMPEG, ["-v", "error", "-y", "-loop", "1", "-framerate", String(fps), "-i", endCardImage,
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", String(endCardDuration),
    "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`,
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", card]);
  clips.push(card);
  console.log(`  独立后期引导卡 ${endCardDuration}s；源镜头完整保留原速`);
}
const normalizedSeconds: number[] = [];
clips.forEach((clip, index) => {
  const target = join(temp, `norm-${String(index).padStart(2, "0")}.mp4`);
  /**
   * 每段音轨必须与画面**等长**（2026-09-26 真机事故修复）：
   * aac 编码器 priming + 帧对齐会让音轨流比画面短十几毫秒，逐段累计后
   * 拼接出来的音轨时间轴会整体提前（真机：5 镜时第 3 镜就偏 -145ms）。
   * 因此归一化时用 `apad` 把声音补到画面时长（补的是静音，≤20ms，听不出来），
   * 下游无论走 concat 滤镜还是 demuxer，时间轴都不会再漂。
   */
  const source = sourceReceipts[index] ?? inspectPostInput({ file: clip, ffprobe: FFPROBE });
  const inFrames = Math.max(1, Math.round(source.durationSec * fps));
  const targetDuration = inFrames / fps;
  run(FFMPEG, [
    "-y", "-i", clip,
    ...(!source.hasAudio ? ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"] : []),
    "-map", "0:v:0", "-map", source.hasAudio ? "0:a:0" : "1:a:0",
    "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps}`,
    "-af", `apad,atrim=end=${targetDuration.toFixed(6)}`,
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
  if (!Number.isFinite(targetVideo) || targetVideo <= 0 || Math.abs(targetVideo - source.durationSec) > 1 / fps + 1e-6) {
    throw new Error("COMPOSE_SOURCE_TIMELINE_CHANGED");
  }
  normalizedSeconds.push(targetVideo);
  console.log(`  ① 归一化 ${basename(clip)} → ${targetVideo.toFixed(2)}s（音轨 ${targetAudio.toFixed(2)}s，Δ${(avDelta * 1000).toFixed(0)}ms）`);
  if (avDelta > 0.01) {
    console.log(`       ⚠ 该段音画长度差 ${(avDelta * 1000).toFixed(0)}ms > 10ms，正式合成按既定时间轴继续，未做相关性或口型二检`);
  }
});

/* ---------- ② 拼接 ---------- */
const raw = join(temp, "raw.mp4");
/**
 * 每段**按画面时长**把音轨切/补到精确长度（2026-09-26 真机事故修复的关键一步）：
 * aac 把音频按 1024 样点（48k 下 21.33ms）成帧，末帧向上取整，
 * 于是每段音轨比画面**长** 0–21ms；不透支这个差，逐段累计就是 33ms/6 镜的漂移。
 * 不变量：每段音轨时长 === 该段画面时长（D = 帧数 / fps）。
 */
const shotSeconds = normalizedSeconds;
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
run(FFMPEG, [
  "-y", "-i", raw,
  ...(filters.length > 0 ? ["-vf", filters.join(",")] : []),
  "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out,
]);
const outDuration = probeDuration(out);
console.log(`  ③ 母版 → ${out}（${outDuration.toFixed(2)}s）`);

// The actual composer has normalized timing/audio. No quality correlation or lip/dialogue review runs.
for (const source of sourceReceipts) {
  const current = inspectPostInput({ file: source.path, ffprobe: FFPROBE });
  if (current.sha256 !== source.sha256) throw new Error(`COMPOSE_SOURCE_CHANGED: ${source.path}`);
}
const composed = inspectPostInput({ file: out, ffprobe: FFPROBE });
const composeReceiptPath = out.replace(/\.mp4$/i, ".compose-receipt.json");
writeFileSync(composeReceiptPath, `${JSON.stringify({ policy: POST_RENDER_ACCEPTANCE_POLICY, qualityReviewed: false,
  sourceReceipts, sourceTiming, output: composed, requested: { width, height, fps, durationSec: null },
  clipTailHolds, normalizedTimeline: sourceTiming.map((source, index) => ({ ...source,
    composedSeconds: shotSeconds[index], frameQuantizationSeconds: Number((shotSeconds[index]! - source.videoSeconds).toFixed(6)), speedFactor: 1 })),
  sourceTimingPolicy: "original speed and complete video timeline; only frame-rate encoding quantization within one frame",
  independentEndCard: endCardImage ? { image: endCardImage, sha256: await sha256File(endCardImage), seconds: endCardDuration, composedSeconds: shotSeconds[sourceTiming.length] } : null,
  transforms: { silencePadding: sourceReceipts.filter(source => !source.hasAudio).map(source => source.path), transition, transitionDuration, fade },
}, null, 2)}\n`, "utf8");

/* ---------- ④ 明确请求的调色加工 ---------- */
let gradedPath: string | null = null;
let colorReport: Record<string, unknown> | null = null;
if (colorMode !== "none") {
  const cli = resolve(REPO_ROOT, "bundles/ai-video/connectors/color-bridge/cli.mjs");
  const target = abs(gradedOut || out.replace(/\.mp4$/i, "-graded.mp4"));
  /**
   * 调色工位有"路径监狱"（core.mjs assertPathAllowed）：只放行 WORKLOOM_COLOR_ALLOWED_ROOTS
   * 内的路径（缺省进程工作目录 + 系统临时目录）。成片若落在别处必须显式放行，
   * 否则 grade 直接 path_not_allowed（真机 2026-09-21 实测）。
   */
  const roots = [dirname(out), dirname(target), REPO_ROOT, tmpdir()].join(":");
  const colorEnv = { ...process.env, WORKLOOM_COLOR_ALLOWED_ROOTS: roots };

  let profile = gradeProfile || "clean-bright", intensity = gradeIntensity, lut = gradeLut ? abs(gradeLut) : "";
  if (recipeId) {
    const recipeFile = resolve(REPO_ROOT, "bundles/ai-video/library/color-recipes/recipes.json");
    const doc = JSON.parse(readFileSync(recipeFile, "utf8")) as { recipes: Array<{ id: string; genre: string; profile: string; intensity: number; lut?: string | null }> };
    const recipe = doc.recipes.find(item => item.id === recipeId || item.genre === recipeId);
    if (!recipe) throw new Error(`题材配方不存在：${recipeId}`);
    profile = gradeProfile || recipe.profile; intensity = arg("--grade-intensity", String(recipe.intensity));
    if (!lut && recipe.lut) lut = resolve(REPO_ROOT, "bundles/ai-video/library/luts", recipe.lut);
  }
  console.log(`  ④ 正式调色：${profile} @${intensity} → ${target}`);
  const result = JSON.parse(run(process.execPath, [cli, "grade", "--in", out, "--out", target,
    "--profile", profile, "--intensity", intensity, "--auto", ...(lut ? ["--lut", lut] : []), "--json"], colorEnv).trim()) as Record<string, unknown>;
  if (result.ok !== true || !existsSync(target)) throw new Error(`COLOR_TRANSFORM_FAILED: ${String(result.error ?? result.message ?? "缺正式调色产物")}`);
  gradedPath = target;
  colorReport = { ...result, qualityReviewed: false, requestedMode: colorMode, appliedProfile: profile };

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
