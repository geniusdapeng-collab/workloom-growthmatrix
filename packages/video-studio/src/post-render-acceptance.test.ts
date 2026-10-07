import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { acceptPostStage, findProviderClip, inspectPostInput, POST_RENDER_STAGES, type RenderedHistoryRow } from "./post-render-acceptance.js";
import { createLineageReceipt, fingerprintArtifact, productionHash } from "./production-lineage.js";
import { reviewStage, type ProducerArtifact, type ProducerStage } from "./producer-gate.js";

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
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

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
