/** 本地屏幕虚化：只派生已生成片段，不具备提交模型、换脸或改造设备的接口。 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fingerprintArtifact, productionHash, type LineageReceipt } from "./production-lineage.js";
import type { ProducerVerdict } from "./producer-gate.js";
import { verifyExistingSuccessfulVideoTask } from "./video-task-receipt.js";

export interface SurfaceRect { x: number; y: number; width: number; height: number }
interface MediaInfo { width: number; height: number; duration: number; frames: number; fps: string; audio: boolean }
export interface SurfacePlan {
  schemaVersion: "workloom.surface-repair/v1";
  projectId: string; shotId: string; taskId: string; sourceHash: string; inputSha256: string;
  input: string; media: MediaInfo; decodeWidth: number; decodeHeight: number;
  frames: SurfaceRect[]; sigma: number; maskFile: string; maskSha256: string;
}
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
function fail(reason: string): never { throw new Error(`SURFACE_REPAIR_UNVERIFIED: ${reason}`); }

/** 本地显式变换复用同作用域的成功供应商字节；历史质量裁决仅保留记录。 */
export function assertSurfaceRepairOrigin(input: {
  projectId: string; shotId: string; sourceHash: string; clip: string; expectedRequestSha256: string;
  submission: LineageReceipt; promptFile: string;
  previous: { ok: boolean; degraded: boolean; verdict: ProducerVerdict | null; lineage?: LineageReceipt };
  taskReceipt: { schemaVersion?: string; projectId?: string; shotId?: string; state?: string; taskId?: string; requestSha256?: string };
}): string {
  const { previous: row, taskReceipt: task } = input, lineage = row.lineage;
  if (!lineage || lineage.schemaVersion !== "workloom.production-lineage/v1"
    || lineage.projectId !== input.projectId || lineage.shotId !== input.shotId
    || lineage.sourceHash !== input.sourceHash) fail("原片作用域/来源不符");
  const artifact = lineage.outputs.find(file => file.path === resolve(input.clip));
  if (!artifact) fail("原来源未绑定该片段");
  const actual = fingerprintArtifact(input.clip);
  if (actual.sha256 !== artifact.sha256 || actual.bytes !== artifact.bytes || actual.realpath !== artifact.realpath) fail("原供应商片段字节已改变");
  const submitted = input.submission;
  if (submitted.schemaVersion !== "workloom.production-lineage/v1" || submitted.stage !== "gate:material-generate:submit"
    || submitted.projectId !== input.projectId || submitted.shotId !== input.shotId || submitted.sourceHash !== input.sourceHash
    || submitted.status !== "passed" || submitted.errors.length
    || !submitted.inputs.some(file => file.path === resolve(input.promptFile))) fail("实际提交提示词缺当前来源的原提交门证明");
  for (const file of [...submitted.inputs, ...submitted.outputs]) {
    const actual = fingerprintArtifact(file.path);
    if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes || actual.realpath !== file.realpath) fail("原提交门的正文/参考已改变");
  }
  if (task.schemaVersion !== "workloom.video-task-receipt/v1" || task.state !== "succeeded"
    || task.projectId !== input.projectId || task.shotId !== input.shotId || !task.taskId?.trim()
    || task.requestSha256 !== input.expectedRequestSha256) fail("必须复用同一受审正文的成功任务，不能重复提交");
  return task.taskId!;
}

/** 跨进程复核实际本地变换产物的来源和字节；不复评历史质量意见。 */
export function assertReviewedSurfaceRepair(input: { projectId: string; shotId: string; sourceHash: string;
  row: { ok: boolean; degraded: boolean; artifact: string | null; verdict: ProducerVerdict | null; lineage?: LineageReceipt } }): string {
  const { row } = input, lineage = row.lineage;
  if (!row.artifact) fail("后期副本缺实际产物");
  if (!lineage || lineage.schemaVersion !== "workloom.production-lineage/v1" || lineage.stage !== "surface-repair" || lineage.status !== "passed"
    || lineage.projectId !== input.projectId || lineage.shotId !== input.shotId || lineage.sourceHash !== input.sourceHash
    || lineage.errors.length || !lineage.outputs.some(file => file.path === resolve(row.artifact!))) fail("后期副本作用域/来源不符");
  for (const file of [...lineage.inputs, ...lineage.outputs]) {
    const actual = fingerprintArtifact(file.path);
    if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes || actual.realpath !== file.realpath) fail("后期副本或实际输入字节已改变");
  }
  return row.artifact;
}

/** 兼容旧调用名：身份/服装/质量意见不再决定成功片段的后期资格。 */
export function assertSurfaceIdentityQualification(input: { projectId: string; shotId: string; sourceHash: string; contractHash: string; clip: string;
  row: { ok: boolean; degraded: boolean; artifact: string | null; verdict: ProducerVerdict | null; lineage?: LineageReceipt } }): void {
  fingerprintArtifact(input.clip);
}

type ReviewedSurfaceRow = { ok: boolean; degraded: boolean; artifact: string | null; verdict: ProducerVerdict | null;
  lineage?: LineageReceipt; evidence: Record<string, unknown> };
/** 复用实际变换副本和原成功请求；无身份复评，也无供应商提交/轮询能力。 */
export async function qualifyReviewedSurfacePost(input: { projectId: string; shotId: string; sourceHash: string; contractHash: string;
  receiptRoot: string; body: Record<string, unknown>; repair: ReviewedSurfaceRow; identity: ReviewedSurfaceRow }): Promise<{
    clip: string; taskId: string; requestSha256: string; original: string; originalSha256: string;
  }> {
  const clip = assertReviewedSurfaceRepair({ ...input, row: input.repair });
  const paid = await verifyExistingSuccessfulVideoTask({ root: input.receiptRoot, projectId: input.projectId, shotId: input.shotId, body: input.body });
  const original = input.repair.evidence.original, originalSha256 = input.repair.evidence.originalSha256;
  if (input.repair.evidence.taskId !== paid.taskId
    || typeof original !== "string" || typeof originalSha256 !== "string" || original === clip
    || fingerprintArtifact(original).sha256 !== originalSha256
    || !input.repair.lineage!.inputs.some(file => file.path === resolve(original) && file.sha256 === originalSha256)) fail("副本未绑定当前原片与同一成功付费任务");
  return { clip, ...paid, original, originalSha256 };
}

/** 灰度连通域仅提出屏幕候选；必须逐帧唯一、几何稳定，供明确请求的本地虚化变换使用。 */
export function detectSurface(frame: Uint8Array, width: number, height: number): SurfaceRect {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 32 || height < 32 || frame.length !== width * height) fail("灰度帧规格非法");
  const visited = new Uint8Array(frame.length), queue = new Int32Array(frame.length), candidates: SurfaceRect[] = [];
  for (let start = 0; start < frame.length; start++) {
    if (visited[start] || frame[start]! > 95) continue;
    let head = 0, tail = 1, minX = width, maxX = 0, minY = height, maxY = 0;
    queue[0] = start; visited[start] = 1;
    while (head < tail) {
      const at = queue[head++]!, x = at % width, y = Math.floor(at / width);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (const next of [x > 0 ? at - 1 : -1, x + 1 < width ? at + 1 : -1, y > 0 ? at - width : -1, y + 1 < height ? at + width : -1]) {
        if (next >= 0 && !visited[next] && frame[next]! <= 95) { visited[next] = 1; queue[tail++] = next; }
      }
    }
    const rect = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
    const area = rect.width * rect.height / frame.length, aspect = rect.width / rect.height;
    if (area < .018 || area > .16 || aspect < 1.2 || aspect > 2.8 || tail / (rect.width * rect.height) < .25
      || minY < 2 || maxY >= height - 2) continue;
    let edge = 0, dark = 0;
    // 一像素抗锯齿/圆角不属于面板内容，检查其内侧黑色边框。
    for (let x = minX + 1; x < maxX; x++) for (const y of [minY + 1, maxY - 1]) { edge++; if (frame[y * width + x]! <= 115) dark++; }
    for (let y = minY + 1; y < maxY; y++) for (const x of [minX + 1, maxX - 1]) { edge++; if (frame[y * width + x]! <= 115) dark++; }
    if (dark / edge >= .85) candidates.push(rect);
  }
  if (candidates.length !== 1) fail(`屏幕候选非唯一：${candidates.length}；不能猜测或以最大面积代替确认`);
  return candidates[0]!;
}

export function stableSurfaceRect(frames: SurfaceRect[], width: number, height: number): SurfaceRect {
  if (frames.length < 2) fail("需要整个片段的逐帧定位证据");
  let previous = frames[0]!;
  for (const r of frames) {
    if (![r.x, r.y, r.width, r.height].every(Number.isInteger) || r.width <= 0 || r.height <= 0
      || r.x < 0 || r.y < 0 || r.x + r.width > width || r.y + r.height > height) fail("定位越界");
    if (Math.abs(r.x - previous.x) > 2 || Math.abs(r.y - previous.y) > 2
      || Math.abs(r.width - previous.width) > 2 || Math.abs(r.height - previous.height) > 2) fail("屏幕定位发生跳变，不能连续跟踪");
    previous = r;
  }
  const x = Math.min(...frames.map(r => r.x)), y = Math.min(...frames.map(r => r.y));
  return { x, y, width: Math.max(...frames.map(r => r.x + r.width)) - x, height: Math.max(...frames.map(r => r.y + r.height)) - y };
}

/** 人手局部遮挡连通边框时，以原屏幕上半部实际像素模板接续定位；偏离/缺证据仍拒绝。 */
export function trackSurface(frame: Uint8Array, previousFrame: Uint8Array, previous: SurfaceRect, width: number, height: number, original: SurfaceRect = previous): SurfaceRect {
  if (frame.length !== width * height || previousFrame.length !== frame.length) fail("跟踪帧规格非法");
  const options: Array<{ rect: SurfaceRect; error: number }> = [];
  for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (let size = -1; size <= 1; size++) {
    const r = { x: previous.x + dx, y: previous.y + dy, width: previous.width + size, height: previous.height + Math.round(size * previous.height / previous.width) };
    if (r.x < 2 || r.y < 2 || r.x + r.width >= width - 2 || r.y + r.height >= height - 2) continue;
    let sum = 0, count = 0;
    for (let y = 1; y < original.height * .60; y++) for (let x = 1; x < original.width - 1; x++) {
      const target = (r.y + Math.floor(y * r.height / original.height)) * width + r.x + Math.floor(x * r.width / original.width);
      sum += Math.abs(previousFrame[(original.y + y) * width + original.x + x]! - frame[target]!); count++;
    }
    options.push({ rect: r, error: sum / count });
  }
  options.sort((a, b) => a.error - b.error);
  if (!options[0] || options[0].error > 14) fail("被遮挡屏幕缺少足够连续模板证据");
  return options[0].rect;
}

/** 原屏幕模板背景差分仅保护从边界进入的大块前景；小图标/界面变化不能因此保留为清晰文字。 */
export function surfaceMask(frame: Uint8Array, baseline: Uint8Array, r: SurfaceRect, original: SurfaceRect, width: number, height: number, rgb: Uint8Array): Buffer {
  if (frame.length !== width * height || baseline.length !== frame.length || rgb.length !== frame.length * 3) fail("mask帧规格非法");
  const result = Buffer.alloc(width * height), residual = new Uint8Array(width * height), visited = new Uint8Array(width * height);
  for (let y = 1; y < r.height - 1; y++) for (let x = 1; x < r.width - 1; x++) {
    const at = (r.y + y) * width + r.x + x;
    result[at] = 255;
    const reference = (original.y + Math.floor(y * original.height / r.height)) * width + original.x + Math.floor(x * original.width / r.width);
    const red = rgb[at * 3]!, green = rgb[at * 3 + 1]!, blue = rgb[at * 3 + 2]!;
    const cb = 128 - .169 * red - .331 * green + .5 * blue, cr = 128 + .5 * red - .419 * green - .081 * blue;
    const skin = red > 90 && green > 40 && blue > 20 && red > green && red > blue && red - Math.min(green, blue) > 15
      && cb >= 85 && cb <= 135 && cr >= 135 && cr <= 180;
    if (skin && Math.abs(frame[at]! - baseline[reference]!) > 25) residual[at] = 1;
  }
  let protectedCount = 0;
  for (let start = 0; start < residual.length; start++) {
    if (!residual[start] || visited[start]) continue;
    const queue = [start]; visited[start] = 1; let boundary = false;
    for (let head = 0; head < queue.length; head++) {
      const at = queue[head]!, x = at % width, y = Math.floor(at / width);
      if (x <= r.x + 2 || x >= r.x + r.width - 3 || y <= r.y + 2 || y >= r.y + r.height - 3) boundary = true;
      for (const next of [x ? at - 1 : -1, x + 1 < width ? at + 1 : -1, y ? at - width : -1, y + 1 < height ? at + width : -1]) {
        if (next >= 0 && residual[next] && !visited[next]) { visited[next] = 1; queue.push(next); }
      }
    }
    if (boundary && queue.length >= r.width * r.height * .015) for (const at of queue) { result[at] = 0; protectedCount++; }
  }
  if (protectedCount > r.width * r.height * .35) fail("遮挡过大，无法安全修复屏幕");
  return result;
}

function mediaInfo(ffprobe: string, file: string): MediaInfo {
  const value = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", file], { encoding: "utf8", timeout: 60_000 }));
  const video = value.streams?.find((item: { codec_type: string }) => item.codec_type === "video");
  const result = { width: Number(video?.width), height: Number(video?.height), duration: Number(value.format?.duration),
    frames: Number(video?.nb_read_frames), fps: String(video?.r_frame_rate ?? ""), audio: value.streams?.some((item: { codec_type: string }) => item.codec_type === "audio") === true };
  if (!Number.isFinite(result.duration) || result.duration <= 0 || result.duration > 30 || !Number.isInteger(result.frames)
    || result.frames < 2 || result.frames > 1800 || result.width < 64 || result.height < 64) fail("输入媒体超出本地修复边界");
  const fps = result.fps.split("/").map(Number);
  if (fps.length !== 2 || !(fps[0]! > 0) || !(fps[1]! > 0) || video.avg_frame_rate !== result.fps
    || Math.abs(result.frames * fps[1]! / fps[0]! - result.duration) > .05 || Number(video.start_time ?? 0) !== 0) fail("当前局部跟踪只支持从0开始的恒定帧率片段");
  return result;
}
function grayVideo(ffmpeg: string, input: string, width: number, height: number): Buffer {
  return execFileSync(ffmpeg, ["-v", "error", "-i", input, "-map", "0:v:0", "-vf", `scale=${width}:${height}`, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 100_000_000, timeout: 120_000 });
}
export function inspectSurfaceRepair(input: { ffmpeg: string; ffprobe: string; input: string; directory: string;
  projectId: string; shotId: string; taskId: string; sourceHash: string }): { plan: SurfacePlan; planFile: string; previews: string[] } {
  const media = mediaInfo(input.ffprobe, input.input), decodeWidth = 160;
  const decodeHeight = Math.round(media.height * decodeWidth / media.width);
  const bytes = grayVideo(input.ffmpeg, input.input, decodeWidth, decodeHeight), size = decodeWidth * decodeHeight;
  const rgb = execFileSync(input.ffmpeg, ["-v", "error", "-i", input.input, "-map", "0:v:0", "-vf", `scale=${decodeWidth}:${decodeHeight}`, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 100_000_000, timeout: 120_000 });
  if (bytes.length !== media.frames * size) fail("实际解码帧数不匹配，不能抽样冒称逐帧定位");
  if (rgb.length !== bytes.length * 3) fail("颜色证据帧数不匹配");
  const frames: SurfaceRect[] = [], masks: Buffer[] = [];
  for (let i = 0; i < media.frames; i++) {
    const frame = bytes.subarray(i * size, (i + 1) * size);
    try {
      let rect: SurfaceRect;
      try {
        rect = detectSurface(frame, decodeWidth, decodeHeight);
        if (i) stableSurfaceRect([frames[i - 1]!, rect], decodeWidth, decodeHeight);
      }
      catch (error) { if (!i) throw error; rect = trackSurface(frame, bytes.subarray(0, size), frames[i - 1]!, decodeWidth, decodeHeight, frames[0]!); }
      frames.push(rect); masks.push(surfaceMask(frame, bytes.subarray(0, size), rect, frames[0]!, decodeWidth, decodeHeight, rgb.subarray(i * size * 3, (i + 1) * size * 3)));
    } catch (error) { throw new Error(`逐帧定位第${i}帧：${error instanceof Error ? error.message : String(error)}`); }
  }
  const selected = stableSurfaceRect(frames, decodeWidth, decodeHeight);
  const rect = { x: Math.floor(selected.x * media.width / decodeWidth / 2) * 2,
    y: Math.floor(selected.y * media.height / decodeHeight / 2) * 2,
    width: Math.ceil(selected.width * media.width / decodeWidth / 2) * 2,
    height: Math.ceil(selected.height * media.height / decodeHeight / 2) * 2 };
  if (rect.x + rect.width > media.width || rect.y + rect.height > media.height) fail("映射实际像素后越界");
  mkdirSync(input.directory, { recursive: true });
  const mask = Buffer.concat(masks), maskSha256 = digest(mask), maskFile = resolve(input.directory, `mask-${maskSha256}.gray`);
  if (!existsSync(maskFile)) writeFileSync(maskFile, mask, { flag: "wx" });
  const plan: SurfacePlan = { schemaVersion: "workloom.surface-repair/v1", projectId: input.projectId, shotId: input.shotId,
    taskId: input.taskId, sourceHash: input.sourceHash, input: resolve(input.input), inputSha256: fingerprintArtifact(input.input).sha256,
    media, decodeWidth, decodeHeight, frames, sigma: Math.max(16, Math.min(64, rect.width * .08)), maskFile, maskSha256 };
  const planFile = join(input.directory, `plan-${productionHash(plan)}.json`);
  if (!existsSync(planFile)) writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx" });
  const previews = [0, .25, .5, .75, .98].map((fraction, i) => {
    const file = join(input.directory, `plan-${productionHash(plan)}-${i}.jpg`);
    const at = Math.min(frames.length - 1, Math.floor((frames.length - 1) * fraction));
    const filter = `[0:v]format=gbrp,split=2[base][area];[area]lutrgb=r=255:g=val*0.5:b=val*0.5[red];[1:v]scale=${media.width}:${media.height}:flags=neighbor,format=gbrp[mask];[base][red][mask]maskedmerge,select=eq(n\\,${at}),scale=720:-2[out]`;
    if (!existsSync(file)) execFileSync(input.ffmpeg, ["-v", "error", "-y", "-i", input.input, "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${decodeWidth}x${decodeHeight}`, "-framerate", media.fps, "-i", maskFile,
      "-filter_complex", filter, "-map", "[out]", "-frames:v", "1", "-q:v", "3", file], { timeout: 30_000 });
    return file;
  });
  return { plan, planFile, previews };
}

/** 明确请求的定位计划绑定输入字节；执行实际局部变换，原文件只读。 */
export function executeSurfaceRepair(input: { ffmpeg: string; ffprobe: string; plan: SurfacePlan; planFile: string;
  previews: string[]; localization: ProducerVerdict; output: string }): { output: string; sha256: string; outsideMeanError: number; audioSha256: string | null } {
  const { plan, localization: verdict } = input;
  if (!verdict.approved || verdict.status !== "passed" || verdict.degraded
    || verdict.hardFailures.length || ![input.planFile, ...input.previews].every(file => verdict.evidence?.some(e => e.path === file && e.sha256 === fingerprintArtifact(file).sha256))) fail("明确请求的定位计划与实际输入字节不一致");
  if (productionHash(JSON.parse(readFileSync(input.planFile, "utf8"))) !== productionHash(plan)
    || fingerprintArtifact(plan.input).sha256 !== plan.inputSha256 || fingerprintArtifact(plan.maskFile).sha256 !== plan.maskSha256
    || resolve(plan.input) === resolve(input.output) || existsSync(input.output)) fail("原片/计划/mask变动或副本已存在，禁止覆盖原证据");
  const maskFile = plan.maskFile;
  // RGB三平面mask的黑/白权重一致；不能用YUV灰度mask的中性UV=128污染区域外颜色。
  const filter = `[0:v]format=gbrp,split=2[base][area];[area]gblur=sigma=${plan.sigma.toFixed(2)}:steps=3[blur];[1:v]scale=${plan.media.width}:${plan.media.height}:flags=neighbor,format=gbrp[mask];[base][blur][mask]maskedmerge[out]`;
  execFileSync(input.ffmpeg, ["-v", "error", "-n", "-i", plan.input, "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${plan.decodeWidth}x${plan.decodeHeight}`, "-framerate", plan.media.fps, "-i", maskFile, "-filter_complex", filter,
    "-map", "[out]", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "copy", "-fps_mode", "passthrough", "-movflags", "+faststart", input.output], { timeout: 180_000 });
  const actual = mediaInfo(input.ffprobe, input.output);
  if (actual.width !== plan.media.width || actual.height !== plan.media.height || actual.frames !== plan.media.frames
    || actual.fps !== plan.media.fps || actual.audio !== plan.media.audio || Math.abs(actual.duration - plan.media.duration) > .05) fail("派生片的媒体规格或时序变化");
  const before = grayVideo(input.ffmpeg, plan.input, plan.decodeWidth, plan.decodeHeight);
  const after = grayVideo(input.ffmpeg, input.output, plan.decodeWidth, plan.decodeHeight);
  let sum = 0, count = 0;
  if (before.length !== after.length) fail("派生片逐帧解码缺失");
  for (let i = 0; i < before.length; i++) {
    const at = i % (plan.decodeWidth * plan.decodeHeight), x = at % plan.decodeWidth, y = Math.floor(at / plan.decodeWidth);
    const small = plan.frames[Math.floor(i / (plan.decodeWidth * plan.decodeHeight))]!;
    if (x >= small.x - 2 && x <= small.x + small.width + 2 && y >= small.y - 2 && y <= small.y + small.height + 2) continue;
    sum += Math.abs(before[i]! - after[i]!); count++;
  }
  const outsideMeanError = sum / count;
  if (!Number.isFinite(outsideMeanError) || outsideMeanError > 3) fail("局部之外像素变化超过重编码容差");
  const audioHash = (file: string) => digest(execFileSync(input.ffmpeg, ["-v", "error", "-i", file, "-map", "0:a:0", "-f", "s16le", "-acodec", "pcm_s16le", "-"], { maxBuffer: 30_000_000, timeout: 60_000 }));
  const audioSha256 = actual.audio ? audioHash(plan.input) : null;
  if (actual.audio && audioHash(input.output) !== audioSha256) fail("原音频发生变化");
  if (fingerprintArtifact(plan.input).sha256 !== plan.inputSha256) fail("后期期间原片发生变化");
  return { output: input.output, sha256: fingerprintArtifact(input.output).sha256, outsideMeanError, audioSha256 };
}
