/** Local cover prepend. The body keeps every frame, its duration and its original speed. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

const hash = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
export function coverIntroTiming(seconds: number, fps: number): { frames: number; seconds: number } {
  if (!Number.isFinite(seconds) || seconds < 0.1 || seconds > 5 || !Number.isInteger(fps) || fps < 1 || fps > 120) {
    throw new Error("COVER_INTRO_TIMING_INVALID");
  }
  const frames = Math.max(1, Math.round(seconds * fps));
  return { frames, seconds: frames / fps };
}

function tool(file: string, args: string[]): string {
  try { return execFileSync(file, args, { encoding: "utf8", timeout: 180_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (error) {
    const failure = error as Error & { stderr?: string | Buffer };
    throw new Error(`COVER_INTRO_TOOL_FAILED: ${file}: ${String(failure.stderr ?? failure.message).slice(-1200)}`);
  }
}
function probe(file: string, ffprobe: string): Record<string, any> {
  const value = JSON.parse(tool(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]));
  if (!Array.isArray(value.streams)) throw new Error("COVER_INTRO_PROBE_INVALID");
  return value;
}

export function prependFilmCover(input: {
  body: string; cover: string; output: string; ffmpeg: string; ffprobe: string;
  seconds?: number; fps: number; width: number; height: number; music?: string;
}) {
  const timing = coverIntroTiming(input.seconds ?? 1.2, input.fps);
  if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width < 2 || input.height < 2
    || input.width % 2 || input.height % 2 || resolve(input.body) === resolve(input.output)) throw new Error("COVER_INTRO_OUTPUT_INVALID");
  const files = [input.body, input.cover, ...(input.music ? [input.music] : [])];
  const originals = files.map(path => {
    if (!statSync(path).isFile() || !statSync(path).size) throw new Error("COVER_INTRO_INPUT_INVALID");
    return { path: resolve(path), sha256: hash(path) };
  });
  const body = probe(input.body, input.ffprobe), video = body.streams.find((row: any) => row.codec_type === "video");
  const sound = body.streams.find((row: any) => row.codec_type === "audio");
  const [top, bottom] = String(video?.avg_frame_rate).split("/").map(Number);
  const frames = Number(video?.nb_frames), bodySeconds = Number(video?.duration);
  if (!video || !sound || !Number.isSafeInteger(frames) || frames <= 0 || !Number.isFinite(bodySeconds) || bodySeconds <= 0
    || Math.abs(top! / bottom! - input.fps) > .001 || video.width !== input.width || video.height !== input.height) {
    throw new Error("COVER_INTRO_BODY_SPEC_INVALID: normalize encoding before adding a cover; do not retime the body");
  }
  const image = probe(input.cover, input.ffprobe).streams.find((row: any) => row.codec_type === "video");
  if (image?.width !== input.width || image?.height !== input.height) throw new Error("COVER_INTRO_IMAGE_SPEC_INVALID");
  mkdirSync(dirname(resolve(input.output)), { recursive: true });
  const work = mkdtempSync(join(dirname(resolve(input.output)), ".cover-intro-")), pending = join(work, "film.mp4");
  try {
    const seconds = timing.seconds.toFixed(9);
    const introAudio = input.music
      ? [`-i`, input.music]
      : ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"];
    const musicFilter = input.music ? `volume=-22dB,afade=t=in:st=0:d=0.06,afade=t=out:st=${Math.max(0, timing.seconds - .08).toFixed(6)}:d=0.08,` : "";
    const filters = [
      `[0:v]setsar=1,format=yuv420p,trim=end_frame=${timing.frames},setpts=PTS-STARTPTS[cover]`,
      `[1:v]setsar=1,format=yuv420p,setpts=PTS-STARTPTS[body]`,
      `[2:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,${musicFilter}atrim=duration=${seconds},asetpts=PTS-STARTPTS[introAudio]`,
      "[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[bodyAudio]",
      "[cover][introAudio][body][bodyAudio]concat=n=2:v=1:a=1[v][a]",
    ].join(";");
    tool(input.ffmpeg, ["-v", "error", "-y", "-loop", "1", "-framerate", String(input.fps), "-i", input.cover,
      "-i", input.body, ...introAudio, "-filter_complex", filters, "-map", "[v]", "-map", "[a]",
      "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(input.fps),
      "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", pending]);
    const result = probe(pending, input.ffprobe), produced = result.streams.find((row: any) => row.codec_type === "video");
    if (Number(produced?.nb_frames) !== frames + timing.frames) throw new Error("COVER_INTRO_FRAME_COUNT_CHANGED");
    if (originals.some(row => hash(row.path) !== row.sha256)) throw new Error("COVER_INTRO_SOURCE_CHANGED");
    const receipt = { schemaVersion: "workloom.cover-intro/v1", body: originals[0], cover: originals[1], music: originals[2] ?? null,
      introSeconds: timing.seconds, introFrames: timing.frames, bodyFrames: frames, outputFrames: Number(produced.nb_frames),
      bodySeconds, outputSeconds: Number(produced.duration), sourceSpeed: 1, bodyFramesPreserved: true,
      output: resolve(input.output), outputSha256: hash(pending), generatedAt: new Date().toISOString() };
    writeFileSync(join(work, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
    renameSync(pending, input.output);
    renameSync(join(work, "receipt.json"), input.output + ".cover-intro.json");
    return receipt;
  } finally { rmSync(work, { recursive: true, force: true }); }
}

/** Shift only cue timestamps; text, styles and cue ordering are unchanged. */
export function shiftSubtitleTimes(source: string, format: "srt" | "ass" | "vtt", seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 5) throw new Error("SUBTITLE_OFFSET_INVALID");
  const offset = (value: string, ass = false): string => {
    const parts = value.replace(",", ".").split(":");
    const [hours, minutes, last] = parts.length === 2 ? [0, Number(parts[0]), Number(parts[1])] : parts.map(Number);
    if (parts.length < 2 || parts.length > 3 || !Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(last)
      || minutes! < 0 || minutes! >= 60 || last! < 0 || last! >= 60) throw new Error("SUBTITLE_TIMESTAMP_INVALID");
    const unit = ass ? 100 : 1000, ticks = Math.round((hours! * 3600 + minutes! * 60 + last! + seconds) * unit);
    const hh = Math.floor(ticks / (3600 * unit)), mm = Math.floor(ticks / (60 * unit)) % 60, ss = Math.floor(ticks / unit) % 60;
    const sub = ticks % unit;
    return `${ass ? hh : String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}${ass || format === "vtt" ? "." : ","}${String(sub).padStart(ass ? 2 : 3, "0")}`;
  };
  if (format === "ass") return source.replace(/^(Dialogue:\s*[^,]*,)([^,]+),([^,]+),/gm, (_line, prefix, start, end) => `${prefix}${offset(start, true)},${offset(end, true)},`);
  return source.replace(/^(\d{1,2}:\d{2}(?::\d{2})?[,.]\d{3})\s+-->\s+(\d{1,2}:\d{2}(?::\d{2})?[,.]\d{3})(.*)$/gm,
    (_line, start, end, options) => `${offset(start)} --> ${offset(end)}${options}`);
}

export function shiftFilmSubtitleDirectory(sourceDir: string, outputDir: string, names: readonly string[], seconds: number): void {
  mkdirSync(outputDir, { recursive: true });
  for (const name of names) {
    if (name !== name.split(/[\\/]/).at(-1)) throw new Error("SUBTITLE_PATH_INVALID");
    const format = extname(name).slice(1);
    if (!["srt", "ass", "vtt"].includes(format)) continue;
    const source = readFileSync(join(sourceDir, name), "utf8");
    writeFileSync(join(outputDir, name), shiftSubtitleTimes(source, format as "srt" | "ass" | "vtt", seconds));
  }
  writeFileSync(join(outputDir, "cover-offset.json"), JSON.stringify({ seconds, originalDirectory: resolve(sourceDir),
    files: names.filter(name => /\.(srt|ass|vtt)$/.test(name)).map(name => ({ name,
      originalSha256: hash(join(sourceDir, name)), shiftedSha256: hash(join(outputDir, name)) })),
    note: "封面片头后移字幕；原旁挂文件及原检查记录保持在原目录，不用原哈希证明新文件", at: new Date().toISOString() }, null, 2) + "\n");
}
