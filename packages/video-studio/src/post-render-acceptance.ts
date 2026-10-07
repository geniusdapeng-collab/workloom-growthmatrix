/** Provider-success clips enter postproduction without a visual or audio quality review.
 * This module only reads metadata and stable artifact/provenance bytes. It never
 * samples frames, decodes a review copy, calls a model, or submits a render.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fingerprintArtifact, type LineageReceipt } from "./production-lineage.js";
import type { ProducerGateOptions, ProducerVerdict } from "./producer-gate.js";

export const POST_RENDER_ACCEPTANCE_POLICY = "workloom.provider-success-direct-post/v1" as const;
export const POST_RENDER_STAGES = new Set(["shot", "compose", "color", "subtitle", "mux", "danmaku", "bgm", "sfx", "cover", "master"]);

export interface PostInputReceipt {
  policy: typeof POST_RENDER_ACCEPTANCE_POLICY;
  path: string; realpath: string; sha256: string; bytes: number;
  durationSec: number; width: number; height: number; hasAudio: boolean;
  qualityReviewed: false;
}

/** The probe needed by the composer, with no planned duration/resolution/audio threshold. */
export function inspectPostInput(input: { file: string; ffprobe?: string }): PostInputReceipt {
  const before = fingerprintArtifact(input.file);
  let value: { streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string }>; format?: { duration?: string } };
  try {
    value = JSON.parse(execFileSync(input.ffprobe ?? process.env.WL_FFPROBE ?? "ffprobe",
      ["-v", "error", "-show_streams", "-show_format", "-of", "json", input.file],
      { encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }));
  } catch (error) {
    throw new Error(`POST_INPUT_NOT_OPENABLE: ${input.file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const video = value.streams?.find(stream => stream.codec_type === "video");
  const durationSec = [video?.duration, value.format?.duration].map(Number).find(value => Number.isFinite(value) && value > 0) ?? 0;
  const width = Number(video?.width), height = Number(video?.height);
  if (!video || !Number.isFinite(durationSec) || durationSec <= 0 || !(width > 0) || !(height > 0)) {
    throw new Error(`POST_INPUT_NOT_OPENABLE: ${input.file}: 缺可供后期读取的视频流或时序`);
  }
  const after = fingerprintArtifact(input.file);
  if (after.sha256 !== before.sha256 || after.realpath !== before.realpath || after.bytes !== before.bytes) {
    throw new Error(`POST_INPUT_CHANGED: ${input.file}`);
  }
  return { policy: POST_RENDER_ACCEPTANCE_POLICY, path: before.path, realpath: before.realpath, sha256: before.sha256,
    bytes: before.bytes, durationSec, width, height, hasAudio: value.streams?.some(stream => stream.codec_type === "audio") === true,
    qualityReviewed: false };
}

export interface RenderedHistoryRow {
  stage?: string; shotId?: string | null; artifact?: string | null; evidence?: Record<string, unknown>; lineage?: LineageReceipt;
}

/** Reuse current provider bytes even when their old quality verdict failed.
 * Source scope, task identity, and artifact hash remain mandatory; component
 * recipe/version and old review score/status cannot invalidate a paid clip.
 */
export function findProviderClip(input: {
  projectId: string; shotId: string; sourceHash: string; candidates: string[];
  records: RenderedHistoryRow[]; taskReceipt?: unknown;
}): { file: string; taskId: string; sha256: string; requestSha256?: string } | null {
  const raw = input.taskReceipt;
  const task = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  if (task && (task.schemaVersion !== "workloom.video-task-receipt/v1" || task.projectId !== input.projectId
    || task.shotId !== input.shotId || task.state !== "succeeded" || typeof task.taskId !== "string" || !task.taskId.trim()
    || typeof task.requestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(task.requestSha256)
    || !task.result || typeof task.result !== "object" || Array.isArray(task.result)
    || (task.result as Record<string, unknown>).taskId !== task.taskId
    || typeof (task.result as Record<string, unknown>).url !== "string" || !String((task.result as Record<string, unknown>).url).trim())) {
    throw new Error("POST_PROVIDER_RECEIPT_INVALID: 原供应商任务未成功或作用域不符，禁止重交");
  }
  for (const candidate of input.candidates) {
    const file = resolve(candidate);
    for (const row of [...input.records].reverse()) {
      const receipt = row.lineage, taskId = row.evidence?.taskId ?? row.evidence?.providerTaskId;
      if (row.shotId !== input.shotId || !receipt || receipt.schemaVersion !== "workloom.production-lineage/v1"
        || receipt.projectId !== input.projectId || receipt.shotId !== input.shotId || receipt.sourceHash !== input.sourceHash
        || typeof taskId !== "string" || !taskId.trim() || (task && task.taskId !== taskId)) continue;
      if (Array.isArray(receipt.outputs) && !receipt.outputs.some(item => item?.path === file)) continue;
      // Stage/source byte provenance is not a quality verdict. A genuine failed
      // provider call cannot be adopted merely because a taskId was written.
      const providerStage = new Set(["shot", "material-gen", "render-source", "identity-fact"]);
      if (!providerStage.has(receipt.stage) || row.stage !== receipt.stage
        || !Array.isArray(receipt.inputs) || receipt.inputs.length === 0 || !Array.isArray(receipt.outputs)
        || !Array.isArray(receipt.errors) || receipt.errors.length > 0
        || !["passed", "failed", "unverified"].includes(receipt.status)) {
        throw new Error("POST_PROVIDER_PROVENANCE_INVALID: 原任务的阶段或字节来源不完整，禁止重交");
      }
      if (row.evidence?.providerStatus !== undefined && !["succeeded", "success"].includes(String(row.evidence.providerStatus))
        || row.evidence?.providerSucceeded === false || row.evidence?.providerFailed === true
        || row.evidence?.gateBlocked || row.evidence?.error) {
        throw new Error("POST_PROVIDER_NOT_SUCCEEDED: 原供应商任务失败或未知，禁止重交");
      }
      const artifact = receipt.outputs.find(item => item?.path === file);
      if (!artifact) continue;
      for (const expected of [...receipt.inputs, artifact]) {
        if (!expected || typeof expected.path !== "string" || typeof expected.realpath !== "string"
          || typeof expected.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(expected.sha256)
          || !Number.isSafeInteger(expected.bytes) || expected.bytes <= 0) {
          throw new Error("POST_PROVIDER_PROVENANCE_INVALID: 原来源字节指纹格式无效");
        }
        const actualInput = fingerprintArtifact(expected.path);
        if (actualInput.sha256 !== expected.sha256 || actualInput.bytes !== expected.bytes || actualInput.realpath !== expected.realpath) {
          throw new Error(`POST_PROVIDER_ARTIFACT_CHANGED: ${expected.path}`);
        }
      }
      const actual = fingerprintArtifact(file);
      // A worker record is backed by the parent component ledger. Standalone
      // callers additionally pass the original provider receipt above.
      return { file, taskId, sha256: actual.sha256,
        ...(task ? { requestSha256: String(task.requestSha256) } : {}) };
    }
  }
  return null;
}

// Only facts about requested postproduction files/transforms can decide post completion.
// Unknown legacy/custom quality votes cannot introduce a second source acceptance gate.
const POST_TECHNICAL_CHECK_IDS = new Set(["exists", "duration", "resolution", "fps", "deliverable-naming",
  "grade-produced", "color-tool-exit", "sidecar-produced", "tool-exit", "timeline", "master-untouched",
  "burned", "rendered", "sfx-produced", "video-untouched", "softsub-produced",
  "video-unchanged", "subtitle-files", "subtitle-delivery", "cover-delivery", "master-resolution",
  "variant-resolutions", "variants-produced", "dimensions", "cover-size", "cover-resolution",
  "local-only", "requested-transform", "output-produced", "output-hash", "input-hash", "source-provenance"]);

export function postTechnicalChecks(checks: ProducerGateOptions["deterministic"]): ProducerGateOptions["deterministic"] {
  return checks.filter(check => POST_TECHNICAL_CHECK_IDS.has(check.id));
}

/** Shared CLI, HTTP and worker behavior; no reference image/model/creative card processing. */
export function acceptPostStage(options: ProducerGateOptions): ProducerVerdict {
  const receipts: PostInputReceipt[] = [], errors: string[] = [];
  const evidence: NonNullable<ProducerVerdict["evidence"]> = [];
  if (options.artifacts.length === 0) errors.push("POST_ARTIFACT_MISSING: 缺正式后期输入或产物");
  const videoStages = new Set(["shot", "compose", "color", "mux", "danmaku", "master"]);
  if (videoStages.has(options.stage) && !options.artifacts.some(artifact => artifact.kind === "video")) {
    errors.push("POST_VIDEO_MISSING: 缺实际可供后期读取的视频文件");
  }
  if (["bgm", "sfx"].includes(options.stage) && !options.artifacts.some(artifact => ["video", "audio"].includes(artifact.kind))) {
    errors.push("POST_MEDIA_MISSING: 缺实际音视频加工输入或产物");
  }
  if (options.stage === "cover" && !options.artifacts.some(artifact => artifact.kind === "image")) {
    errors.push("POST_IMAGE_MISSING: 缺实际封面文件");
  }

  for (const artifact of options.artifacts) {
    try {
      if (artifact.kind === "video") {
        const receipt = inspectPostInput({ file: artifact.path }); receipts.push(receipt);
        evidence.push({ path: receipt.path, sha256: receipt.sha256, scope: "post-input-metadata-and-bytes;quality-not-reviewed" });
      } else {
        const receipt = fingerprintArtifact(artifact.path);
        evidence.push({ path: receipt.path, sha256: receipt.sha256, scope: "post-artifact-bytes;quality-not-reviewed" });
      }
    } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }
  return { ...postAcceptanceVerdict({ stage: options.stage, checks: options.deterministic, receipts, errors }), evidence };
}

/** Technical failures describe missing output or failed post transforms; score is deliberately absent. */
export function postAcceptanceVerdict(input: {
  stage: ProducerVerdict["stage"]; checks?: ProducerGateOptions["deterministic"]; receipts?: PostInputReceipt[];
  errors?: string[]; contractHash?: string;
}): ProducerVerdict {
  const checks = input.stage === "shot" ? [] : postTechnicalChecks(input.checks ?? []);
  const hardFailures = [...(input.errors ?? []), ...checks.filter(check => check.hard === true
    && (check.pass !== true || check.status === "failed" || check.status === "unverified"))
    .map(check => `${check.id}: ${check.detail}`)];
  return { stage: input.stage, status: hardFailures.length ? "failed" : "passed", approved: hardFailures.length === 0,
    score: null, hardFailures, issues: [], suggestions: [], rerun: false, via: "deterministic", ms: 0, degraded: false,
    reason: hardFailures.length ? `正式后期技术失败: ${hardFailures.join("; ")}`
      : `${POST_RENDER_ACCEPTANCE_POLICY}: 供应商成功片段默认接受；未做画面、身份、服装、运动、对白或口型质量评审`,
    ...(input.contractHash ? { contractHash: input.contractHash } : {}),
    evidence: (input.receipts ?? []).map(receipt => ({ path: receipt.path, sha256: receipt.sha256, scope: "video" })) };
}

export function readProviderReceipt(file: string): unknown {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { throw new Error(`POST_PROVIDER_RECEIPT_UNREADABLE: ${error instanceof Error ? error.message : String(error)}`); }
}
