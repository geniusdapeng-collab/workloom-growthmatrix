import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { acceptPostStage, findProviderClip, inspectPostInput, POST_RENDER_STAGES, type RenderedHistoryRow } from "./post-render-acceptance.js";
import { createLineageReceipt, fingerprintArtifact, productionHash } from "./production-lineage.js";
import { reviewStage, type ProducerArtifact, type ProducerStage } from "./producer-gate.js";
import { assertVideoTaskReceiptIdentity, resumeOrSubmitVideoTask, videoTaskReceiptPath, type VideoTaskReceipt } from "./video-task-receipt.js";

const directories: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "direct-post-")); directories.push(root);
  const source = join(root, "原稿.json"), video = join(root, "成功原片.mp4");
  writeFileSync(source, JSON.stringify({ shots: [{ shotId: "S1", duration: 10, scene: "静止黑色空镜" }] }));
  const generated = spawnSync(process.env.WL_FFMPEG ?? "ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i",
    "color=c=black:size=162x90:rate=23", "-t", "10.04", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", video],
    { encoding: "utf8", timeout: 30_000 });
  if (generated.status !== 0) throw new Error(`OFFLINE_FIXTURE_FAILED: ${generated.stderr}`);
  const sourceHash = productionHash(JSON.parse(readFileSync(source, "utf8")));
  const lineage = createLineageReceipt({ projectId: "P", shotId: "S1", runId: "past-run", stage: "shot", sourceHash,
    recipe: { componentVersion: "old", fps: 24, qualityThreshold: 95 }, status: "failed", inputs: [source], outputs: [video] });
  const row = { stage: "shot", shotId: "S1", artifact: video, ok: false,
    evidence: { taskId: "paid-task-1" }, verdict: { approved: false, score: 0, reason: "旧身份/服装/静态/原音质量打回" }, lineage };
  const taskReceipt = { schemaVersion: "workloom.video-task-receipt/v1", projectId: "P", shotId: "S1", state: "succeeded",
    taskId: "paid-task-1", requestSha256: "a".repeat(64), result: { taskId: "paid-task-1", url: "https://provider.invalid/original.mp4", lastFrame: null } };
  return { root, source, video, sourceHash, row, taskReceipt };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** Exercise the actual durable writer with explicitly offline supplier responses. */
const currentTaskBody = { model: "offline-fixture-model", content: [{ type: "text", text: "完整原稿；保留源节目音轨与最后一帧" }] };
async function currentTask(input: { root: string; projectId?: string; shotId?: string }) {
  const projectId = input.projectId ?? "P", shotId = input.shotId ?? "S1";
  const submit = vi.fn(async () => ({ ok: true, status: 200, text: '{"id":"paid-task-1"}' }));
  const poll = vi.fn(async (taskId: string) => {
    expect(taskId).toBe("paid-task-1");
    return { ok: true, status: 200, text: '{"status":"succeeded","content":{"video_url":"https://provider.invalid/original.mp4"}}' };
  });
  const result = await resumeOrSubmitVideoTask({ root: input.root, projectId, shotId,
    body: currentTaskBody,
    transport: { submit, poll }, wait: async () => undefined });
  const journal = videoTaskReceiptPath(input.root, projectId, shotId);
  const receipt = JSON.parse(readFileSync(journal, "utf8")) as VideoTaskReceipt;
  assertVideoTaskReceiptIdentity(receipt);
  expect(receipt).toMatchObject({ schemaVersion: "workloom.video-task-receipt/v2", state: "succeeded", taskId: result.taskId });
  expect(submit).toHaveBeenCalledTimes(1); expect(poll).toHaveBeenCalledTimes(1);
  return { receipt, journal, submit, poll };
}

function mediaBytes(file: string, args: string[]): Buffer {
  const result = spawnSync(process.env.WL_FFMPEG ?? "ffmpeg", ["-v", "error", "-i", file, ...args],
    { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`OFFLINE_MEDIA_CHECK_FAILED: ${result.stderr.toString()}`);
  return result.stdout;
}

describe("supplier success enters official post without another quality decision", () => {
  it("accepts black, low-resolution, odd-fps, odd-duration, silent source and leaves its bytes unchanged", async () => {
    const { video } = fixture(), before = fingerprintArtifact(video);
    const receipt = inspectPostInput({ file: video });
    expect(receipt).toMatchObject({ width: 162, height: 90, hasAudio: false, qualityReviewed: false });
    expect(receipt.durationSec).toBeGreaterThan(10); expect(receipt.durationSec).toBeLessThan(10.1);
    let calls = 0;
    const verdict = await reviewStage({ stage: "shot", projectId: "P", artifacts: [{ path: video, kind: "video" }], env: {},
      minScore: Number.NaN, referenceImages: ["/missing-identity.png"], requiredCheckIds: ["identity", "audio-review"],
      contracts: { shots: [{ shotId: "S1" }] }, deterministic: [
        { id: "duration", pass: false, hard: true, detail: "10.04 与名义10不相等" },
        { id: "resolution", pass: false, hard: true, detail: "低分辨率原片" },
        { id: "wardrobe-custom", pass: false, hard: true, detail: "旧服装审核" }],
      fetchImpl: (async () => { calls += 1; throw new Error("NO_POST_MODEL_CALL_ALLOWED"); }) as typeof fetch });
    expect(verdict).toMatchObject({ approved: true, score: null, rerun: false, degraded: false });
    expect(calls).toBe(0); expect(fingerprintArtifact(video)).toEqual(before);
  });

  it.each([...POST_RENDER_STAGES] as ProducerStage[])("%s ignores source quality requirements and models but keeps real artifact provenance", async stage => {
    const { root, video } = fixture();
    const image = join(root, "cover.png"), subtitle = join(root, "subtitle.srt");
    writeFileSync(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64"));
    writeFileSync(subtitle, "1\n00:00:00,000 --> 00:00:01,000\n原台词\n");
    const artifact: ProducerArtifact = stage === "cover" ? { path: image, kind: "image" }
      : stage === "subtitle" ? { path: subtitle, kind: "text" } : { path: video, kind: "video" };
    let calls = 0;
    const verdict = await reviewStage({ stage, projectId: "P", artifacts: [artifact], deterministic: [
      { id: "identity", pass: false, hard: true, detail: "旧身份审核" },
      { id: "audio-review", pass: false, hard: true, detail: "旧听音审核" },
      { id: "custom-model-vote", pass: false, hard: true, detail: "未知二次审核" }],
      referenceImages: ["/missing-reference"], requiredCheckIds: ["audio-review"], minScore: 999,
      fetchImpl: (async () => { calls += 1; throw new Error("NO_POST_MODEL_CALL_ALLOWED"); }) as typeof fetch });
    expect(verdict.approved, verdict.reason).toBe(true); expect(verdict.score).toBeNull();
    expect(calls).toBe(0); expect(verdict.evidence?.[0]?.sha256).toBe(fingerprintArtifact(artifact.path).sha256);
  });

  it("preserves final export and actual transform failures rather than turning them into source rejection", () => {
    const { video } = fixture();
    const verdict = acceptPostStage({ stage: "master", projectId: "P", artifacts: [{ path: video, kind: "video" }],
      deterministic: [{ id: "resolution", pass: false, hard: true, detail: "实际最终导出尺寸未满足合同" }] });
    expect(verdict.approved).toBe(false); expect(verdict.rerun).toBe(false); expect(verdict.reason).toContain("resolution");
    for (const artifacts of [[], [{ path: "/missing.mp4", kind: "video" as const }], [{ path: video, kind: "text" as const }]]) {
      expect(acceptPostStage({ stage: "shot", projectId: "P", artifacts, deterministic: [] }).approved).toBe(false);
    }
    const corrupt = join(directories.at(-1)!, "corrupt.mp4"); writeFileSync(corrupt, "not a media container");
    expect(() => inspectPostInput({ file: corrupt })).toThrow("POST_INPUT_NOT_OPENABLE");
  });

  it("reuses the same original paid task across component changes and old failed quality verdicts without mutating history", () => {
    const { video, sourceHash, row, taskReceipt } = fixture(), before = JSON.stringify(row);
    expect(findProviderClip({ projectId: "P", shotId: "S1", sourceHash, candidates: [video], records: [row], taskReceipt }))
      .toMatchObject({ file: video, taskId: "paid-task-1", requestSha256: "a".repeat(64) });
    expect(JSON.stringify(row)).toBe(before);
    expect(findProviderClip({ projectId: "P", shotId: "S1", sourceHash, candidates: [video], records: [row] })?.taskId).toBe("paid-task-1");
    expect(findProviderClip({ projectId: "other", shotId: "S1", sourceHash, candidates: [video], records: [row] })).toBeNull();
    expect(findProviderClip({ projectId: "P", shotId: "S1", sourceHash: "b".repeat(64), candidates: [video], records: [row] })).toBeNull();
  });

  it.each(["failed", "queued", "unknown", "", null])("rejects actual supplier status %j and never converts it to quality acceptance", providerStatus => {
    const { video, sourceHash, row } = fixture();
    expect(() => findProviderClip({ projectId: "P", shotId: "S1", sourceHash, candidates: [video],
      records: [{ ...row, evidence: { ...row.evidence, providerStatus } }] })).toThrow("POST_PROVIDER_NOT_SUCCEEDED");
  });

  it("rejects altered or missing input/output bytes, incomplete provenance, task scope changes and actual tool errors", () => {
    const { source, video, sourceHash, row, taskReceipt } = fixture();
    const find = (records: RenderedHistoryRow[] = [row], receipt: unknown = taskReceipt) => findProviderClip({ projectId: "P", shotId: "S1", sourceHash,
      candidates: [video], records, taskReceipt: receipt });
    expect(() => find([{ ...row, lineage: { ...row.lineage, inputs: [] } }])).toThrow("PROVENANCE_INVALID");
    expect(() => find([{ ...row, lineage: { ...row.lineage, stage: "prompt" } }])).toThrow("PROVENANCE_INVALID");
    expect(() => find([{ ...row, evidence: { ...row.evidence, error: "actual supplier download failed" } }])).toThrow("NOT_SUCCEEDED");
    expect(() => find([row], { ...taskReceipt, shotId: "other" })).toThrow("RECEIPT_INVALID");
    expect(() => find([row], { ...taskReceipt, requestSha256: "" })).toThrow("RECEIPT_INVALID");
    expect(() => find([row], { ...taskReceipt, result: { ...taskReceipt.result, taskId: "other" } })).toThrow("RECEIPT_INVALID");
    expect(() => find([row], { ...taskReceipt, result: { ...taskReceipt.result, url: "" } })).toThrow("RECEIPT_INVALID");
    const originalSource = readFileSync(source); writeFileSync(source, "changed source");
    expect(() => find()).toThrow("ARTIFACT_CHANGED"); writeFileSync(source, originalSource);
    writeFileSync(video, "changed paid bytes"); expect(() => find()).toThrow("ARTIFACT_CHANGED");
    rmSync(video); expect(() => find()).toThrow();
  });
});

describe("current v2 supplier task enters the same read-only post adopter", () => {
  it("current v2 writer preserves every real source frame, the red tail, original audio and failed quality history", async () => {
    const { root, source, video, sourceHash, row } = fixture();
    const generated = spawnSync(process.env.WL_FFMPEG ?? "ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i",
      "testsrc2=size=160x90:rate=6", "-f", "lavfi", "-i", "sine=frequency=733:sample_rate=48000",
      "-vf", "drawbox=x=0:y=0:w=iw:h=ih:color=red:t=fill:enable='eq(n,11)'", "-t", "2",
      "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", video],
      { encoding: "utf8", timeout: 30_000 });
    expect(generated.status, generated.stderr).toBe(0);
    const lineage = createLineageReceipt({ projectId: "P", shotId: "S1", runId: "past-run", stage: "shot", sourceHash,
      recipe: { componentVersion: "old", qualityThreshold: 95 }, status: "failed", inputs: [source], outputs: [video] });
    const history = [{ ...row, lineage }], historyBefore = JSON.stringify(history);
    const before = fingerprintArtifact(video), inputBefore = fingerprintArtifact(source);
    const frames = () => mediaBytes(video, ["-map", "0:v:0", "-an", "-f", "framemd5", "-"]).toString();
    const audio = () => mediaBytes(video, ["-map", "0:a:0", "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"]);
    const beforeFrames = frames(), beforeAudio = audio();
    expect(beforeFrames.split("\n").filter(line => line && !line.startsWith("#"))).toHaveLength(12);
    expect(beforeAudio.length).toBeGreaterThanOrEqual(96_000 * 4);
    const last = mediaBytes(video, ["-vf", "select=eq(n\\,11)", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
    expect(last.length).toBe(160 * 90 * 3);
    expect(last[0]).toBeGreaterThan(200); expect(last[1]).toBeLessThan(50); expect(last[2]).toBeLessThan(50);
    const tail = mediaBytes(video, ["-ss", "1.5", "-t", "0.5", "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"]);
    expect(tail.length).toBe(24_000 * 4);
    let energy = 0, crossings = 0;
    for (let index = 0; index < tail.length / 4; index += 1) {
      const sample = tail.readFloatLE(index * 4); energy += sample * sample;
      if (index && tail.readFloatLE((index - 1) * 4) <= 0 && sample > 0) crossings += 1;
    }
    expect(Math.sqrt(energy / 24_000)).toBeGreaterThan(0.01); expect(crossings / 0.5).toBeCloseTo(733, -1);
    const { receipt, journal, submit, poll } = await currentTask({ root }), journalBefore = readFileSync(journal);
    // Identical provenance/task/result with the historical schema remains the compatibility control.
    const args = { projectId: "P", shotId: "S1", sourceHash, candidates: [video], records: history };
    expect(findProviderClip({ ...args, taskReceipt: { ...receipt, schemaVersion: "workloom.video-task-receipt/v1" } }))
      .toMatchObject({ file: video, taskId: "paid-task-1", sha256: before.sha256, requestSha256: receipt.requestSha256 });
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("NO_POST_NETWORK_ALLOWED"); });
    const adopted = findProviderClip({ ...args, taskReceipt: receipt });
    expect(adopted).toMatchObject({ file: video, taskId: "paid-task-1", sha256: before.sha256, requestSha256: receipt.requestSha256 });
    const verdict = await reviewStage({ stage: "shot", projectId: "P", artifacts: [{ path: adopted!.file, kind: "video" }],
      deterministic: [{ id: "identity", pass: false, hard: true, detail: "旧品质打回不能替代供应商成功事实" }],
      env: {}, fetchImpl: network });
    expect(verdict).toMatchObject({ approved: true, score: null, rerun: false });
    expect(inspectPostInput({ file: adopted!.file })).toMatchObject({ hasAudio: true, qualityReviewed: false, durationSec: 2 });
    expect(frames()).toBe(beforeFrames); expect(audio()).toEqual(beforeAudio);
    expect(fingerprintArtifact(video)).toEqual(before); expect(fingerprintArtifact(source)).toEqual(inputBefore);
    expect(readFileSync(journal)).toEqual(journalBefore); expect(JSON.stringify(history)).toBe(historyBefore);
    expect(submit).toHaveBeenCalledTimes(1); expect(poll).toHaveBeenCalledTimes(1); expect(network).not.toHaveBeenCalled();
  });

  const invalidTasks: Array<[string, (value: Record<string, unknown>) => void]> = [
    ["identity digest", value => { value.identitySha256 = "0".repeat(64); }],
    ["request digest", value => { value.requestSha256 = "0".repeat(64); }],
    ["body", value => { (value.identity as VideoTaskReceipt["identity"]).body.model = "changed-model"; }],
    ["provider", value => { (value.identity as VideoTaskReceipt["identity"]).provider = "changed-provider"; }],
    ["endpoint", value => { (value.identity as VideoTaskReceipt["identity"]).endpoint = "https://different.invalid/tasks"; }],
    ["method", value => { (value.identity as Record<string, unknown>).method = "GET"; }],
    ["identity project", value => { (value.identity as VideoTaskReceipt["identity"]).projectId = "another-project"; }],
    ["identity shot", value => { (value.identity as VideoTaskReceipt["identity"]).shotId = "another-shot"; }],
    ["project", value => { value.projectId = "another-project"; }],
    ["shot", value => { value.shotId = "another-shot"; }],
    ["missing identity", value => { delete value.identity; }],
    ["array identity", value => { value.identity = []; }],
    ["null identity", value => { value.identity = null; }],
    ["invalid model", value => { (value.identity as VideoTaskReceipt["identity"]).body.model = ""; }],
    ["secret field", value => { (value.identity as VideoTaskReceipt["identity"]).body.api_key = "test-only-synthetic-forbidden-field"; }],
    ["unknown schema", value => { value.schemaVersion = "workloom.video-task-receipt/v3"; }],
    ["array v1 schema", value => { value.schemaVersion = ["workloom.video-task-receipt/v1"]; }],
    ["array v2 schema", value => { value.schemaVersion = ["workloom.video-task-receipt/v2"]; }],
    ["missing schema", value => { delete value.schemaVersion; }],
    ["null schema", value => { value.schemaVersion = null; }],
    ["invalid origin", value => { value.origin = "untrusted"; }],
    ["submitting", value => { value.state = "submitting"; }],
    ["submitted", value => { value.state = "submitted"; }],
    ["rejected", value => { value.state = "rejected"; }],
    ["unknown state", value => { value.state = "unknown"; }],
    ["invalid task", value => { value.taskId = "../different-task"; }],
    ["missing task", value => { delete value.taskId; }],
    ["wrong result task", value => { (value.result as Record<string, unknown>).taskId = "different-task"; }],
    ["unsafe result URL", value => { (value.result as Record<string, unknown>).url = "file:///local.mp4"; }],
    ["credential result URL", value => { (value.result as Record<string, unknown>).url = "https://x:x@provider.invalid/clip.mp4"; }],
    ["unsafe last frame", value => { (value.result as Record<string, unknown>).lastFrame = "file:///last.png"; }],
    ["array result", value => { value.result = []; }],
    ["null result", value => { value.result = null; }],
  ];
  it.each(invalidTasks)("rejects v2 %s before postproduction and without another supplier request", async (_name, mutate) => {
    const { root, source, video, sourceHash, row } = fixture(), { receipt, journal, submit, poll } = await currentTask({ root });
    const before = [fingerprintArtifact(source), fingerprintArtifact(video)], journalBefore = readFileSync(journal), historyBefore = JSON.stringify(row);
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("NO_POST_NETWORK_ALLOWED"); });
    const changed = structuredClone(receipt) as unknown as Record<string, unknown>; mutate(changed);
    expect(() => findProviderClip({ projectId: "P", shotId: "S1", sourceHash, candidates: [video], records: [row], taskReceipt: changed }))
      .toThrow("POST_PROVIDER_RECEIPT_INVALID");
    expect([fingerprintArtifact(source), fingerprintArtifact(video)]).toEqual(before);
    expect(readFileSync(journal)).toEqual(journalBefore); expect(JSON.stringify(row)).toBe(historyBefore);
    expect(submit).toHaveBeenCalledTimes(1); expect(poll).toHaveBeenCalledTimes(1); expect(network).not.toHaveBeenCalled();
  });

  const malformedReceipts: Array<[string, unknown]> = [["empty string", ""], ["boolean", false], ["zero", 0],
    ["empty array", []], ["array", ["succeeded"]], ["string", "succeeded"]];
  it.each(malformedReceipts)("rejects an explicitly malformed task receipt %s", (_name, receipt) => {
    const { video, sourceHash, row } = fixture();
    expect(() => findProviderClip({ projectId: "P", shotId: "S1", sourceHash, candidates: [video], records: [row], taskReceipt: receipt }))
      .toThrow("POST_PROVIDER_RECEIPT_INVALID");
  });

  it("keeps legacy v1 and the actual imported legacy-resume-only v2 task without POST/GET or history rewrites", async () => {
    const { root, video, sourceHash, row, taskReceipt } = fixture();
    const legacy = { ...taskReceipt, requestSha256: productionHash(currentTaskBody) };
    const legacyFile = join(root, `${productionHash({ projectId: "P", shotId: "S1" })}.json`);
    writeFileSync(legacyFile, JSON.stringify(legacy)); const legacyBytes = readFileSync(legacyFile);
    const deny = vi.fn(async () => { throw new Error("NO_SUPPLIER_CALL_FOR_SUCCESSFUL_LEGACY"); });
    await resumeOrSubmitVideoTask({ root, projectId: "P", shotId: "S1", body: currentTaskBody,
      transport: { submit: deny, poll: deny }, wait: async () => undefined });
    const journal = videoTaskReceiptPath(root, "P", "S1"), imported = JSON.parse(readFileSync(journal, "utf8")) as VideoTaskReceipt;
    assertVideoTaskReceiptIdentity(imported);
    expect(imported).toMatchObject({ origin: "legacy-resume-only", state: "succeeded", taskId: "paid-task-1", legacy: [{ endpointVerified: false }] });
    const historyBefore = JSON.stringify(row), journalBefore = readFileSync(journal), args = { projectId: "P", shotId: "S1", sourceHash, candidates: [video], records: [row] };
    const old = findProviderClip({ ...args, taskReceipt: legacy }), current = findProviderClip({ ...args, taskReceipt: imported });
    expect(current).toEqual(old); expect(current?.taskId).toBe("paid-task-1"); expect(current?.requestSha256).toBe(legacy.requestSha256);
    expect(findProviderClip({ ...args, taskReceipt: null })).toMatchObject({ taskId: "paid-task-1" });
    expect(readFileSync(legacyFile)).toEqual(legacyBytes); expect(readFileSync(journal)).toEqual(journalBefore); expect(JSON.stringify(row)).toBe(historyBefore);
    expect(deny).not.toHaveBeenCalled();
  });

  it("preserves v2 current input/lineage/source-byte and task-scope rejection after identity succeeds", async () => {
    const { root, source, video, sourceHash, row } = fixture(), { receipt, submit, poll } = await currentTask({ root });
    const find = (records: RenderedHistoryRow[] = [row], override: { projectId?: string; shotId?: string; sourceHash?: string; candidates?: string[] } = {}) =>
      findProviderClip({ projectId: "P", shotId: "S1", sourceHash, candidates: [video], records, taskReceipt: receipt, ...override });
    expect(find([row], { candidates: [] })).toBeNull(); expect(find([])).toBeNull();
    for (const wrong of [{ projectId: "other" }, { shotId: "other" }]) expect(() => find([row], wrong)).toThrow("RECEIPT_INVALID");
    expect(find([row], { sourceHash: "0".repeat(64) })).toBeNull();
    expect(find([{ ...row, evidence: { taskId: "different-task" } }])).toBeNull();
    for (const lineage of [{ ...row.lineage, projectId: "other" }, { ...row.lineage, shotId: "other" }, { ...row.lineage, sourceHash: "0".repeat(64) }]) {
      expect(find([{ ...row, lineage }])).toBeNull();
    }
    for (const lineage of [{ ...row.lineage, inputs: [] }, { ...row.lineage, errors: ["actual download failed"] },
      { ...row.lineage, outputs: [{ ...row.lineage.outputs[0]!, sha256: "0".repeat(64) }] },
      { ...row.lineage, inputs: [{ ...row.lineage.inputs[0]!, bytes: 0 }] }]) {
      expect(() => find([{ ...row, lineage }])).toThrow(/PROVENANCE_INVALID|ARTIFACT_CHANGED/);
    }
    for (const evidence of [{ ...row.evidence, providerStatus: "failed" }, { ...row.evidence, providerSucceeded: false },
      { ...row.evidence, providerFailed: true }, { ...row.evidence, gateBlocked: true }, { ...row.evidence, error: "actual download failed" }]) {
      expect(() => find([{ ...row, evidence }])).toThrow("NOT_SUCCEEDED");
    }
    const sourceBefore = readFileSync(source), videoBefore = readFileSync(video);
    writeFileSync(source, "changed approved source"); expect(() => find()).toThrow("ARTIFACT_CHANGED"); writeFileSync(source, sourceBefore);
    writeFileSync(video, "changed paid original"); expect(() => find()).toThrow("ARTIFACT_CHANGED"); writeFileSync(video, videoBefore);
    rmSync(source); expect(() => find()).toThrow();
    expect(submit).toHaveBeenCalledTimes(1); expect(poll).toHaveBeenCalledTimes(1);
  });

  it("keeps actual post tool failure after valid v2 adoption without another supplier/model call", async () => {
    const { root, source, video, sourceHash, row } = fixture(), { receipt, submit, poll } = await currentTask({ root });
    const before = [fingerprintArtifact(source), fingerprintArtifact(video)], historyBefore = JSON.stringify(row);
    const adopted = findProviderClip({ projectId: "P", shotId: "S1", sourceHash, candidates: [video], records: [row], taskReceipt: receipt });
    expect(adopted?.taskId).toBe("paid-task-1");
    vi.stubEnv("WL_FFPROBE", join(root, "missing-ffprobe"));
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("NO_POST_NETWORK_ALLOWED"); });
    const result = await reviewStage({ stage: "shot", projectId: "P", artifacts: [{ path: adopted!.file, kind: "video" }],
      deterministic: [], env: {}, fetchImpl: network });
    expect(result).toMatchObject({ approved: false, score: null, rerun: false }); expect(result.reason).toContain("POST_INPUT_NOT_OPENABLE");
    expect([fingerprintArtifact(source), fingerprintArtifact(video)]).toEqual(before); expect(JSON.stringify(row)).toBe(historyBefore);
    expect(submit).toHaveBeenCalledTimes(1); expect(poll).toHaveBeenCalledTimes(1); expect(network).not.toHaveBeenCalled();
  });
});
