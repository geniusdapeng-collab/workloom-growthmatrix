import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createLineageReceipt, fingerprintArtifact, productionHash } from "./production-lineage.js";
import { assertReviewedSurfaceRepair, assertSurfaceIdentityQualification, assertSurfaceRepairOrigin, detectSurface, executeSurfaceRepair, inspectSurfaceRepair, qualifyReviewedSurfacePost, stableSurfaceRect, surfaceMask, trackSurface } from "./video-surface-repair.js";
import type { ProducerVerdict } from "./producer-gate.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const directory = () => { const root = mkdtempSync(join(tmpdir(), "surface-repair-")); roots.push(root); return root; };
const width = 160, height = 284, screen = { x: 20, y: 80, width: 50, height: 32 };
function frame(x = screen.x, y = screen.y): Buffer {
  const value = Buffer.alloc(width * height, 220);
  for (let by = y; by < y + screen.height; by++) for (let bx = x; bx < x + screen.width; bx++) value[by * width + bx] = 25 + (bx - x) % 8 * 6 + (by - y) % 7 * 3;
  return value;
}
const verdict = (approved: boolean, files: string[] = []): ProducerVerdict => ({ stage: "shot", status: approved ? "passed" : "failed", approved,
  score: approved ? 95 : 40, hardFailures: [], issues: [], suggestions: [], rerun: !approved, via: "llm", model: "explicit-test-double", ms: 1,
  reason: "明确模型测试替身，不充当实际片段审批", degraded: false,
  evidence: files.map(path => ({ path, sha256: fingerprintArtifact(path).sha256, scope: "image" })) });

it("只提出唯一横向屏幕候选；人物/摄像头小块不构成屏幕", () => {
  const pixels = frame();
  for (let y = 125; y < 245; y++) for (let x = 100; x < 135; x++) pixels[y * width + x] = 20;
  for (let y = 68; y < 74; y++) for (let x = 40; x < 53; x++) pixels[y * width + x] = 20;
  expect(detectSurface(pixels, width, height)).toEqual(screen);
});
it("无屏幕、两个屏幕、无效字节拒绝猜测", () => {
  expect(() => detectSurface(Buffer.alloc(width * height, 200), width, height)).toThrow("非唯一：0");
  const two = frame();
  for (let y = 180; y < 212; y++) for (let x = 80; x < 130; x++) two[y * width + x] = 20;
  expect(() => detectSurface(two, width, height)).toThrow("非唯一：2");
  expect(() => detectSurface(Buffer.alloc(1), width, height)).toThrow("规格非法");
});
it("屏幕从侧边局部出画仍识别可见表面，顶/底截断拒绝", () => {
  expect(detectSurface(frame(0), width, height)).toMatchObject({ x: 0, width: 50 });
  expect(() => detectSurface(frame(20, 0), width, height)).toThrow("非唯一：0");
});
it("整个序列必须逐帧连续；不接受跳变、空记录或越界", () => {
  expect(stableSurfaceRect([screen, { ...screen, x: 22 }], width, height)).toEqual({ ...screen, width: 52 });
  expect(() => stableSurfaceRect([screen, { ...screen, x: 50 }], width, height)).toThrow("跳变");
  expect(() => stableSurfaceRect([], width, height)).toThrow("逐帧");
  expect(() => stableSurfaceRect([screen, { ...screen, x: 150 }], width, height)).toThrow("越界");
});
it("底部手遮挡时由固定原屏幕上半部模板继续定位；改变整个模板则拒绝", () => {
  const baseline = frame(), next = frame(22, 81);
  for (let y = 103; y < 115; y++) for (let x = 55; x < 73; x++) next[y * width + x] = 180;
  expect(trackSurface(next, baseline, screen, width, height)).toMatchObject({ x: 22, y: 81, width: 50 });
  expect(() => trackSurface(Buffer.alloc(width * height, 220), baseline, screen, width, height)).toThrow("模板证据");
});
it("前景保护不把白色图标保留为清晰界面，手部大块只在实际皮肤残差处留空", () => {
  const baseline = frame(), next = Buffer.from(baseline), rgb = Buffer.alloc(width * height * 3, 40);
  for (let y = 105; y < 111; y++) for (let x = 62; x < 69; x++) {
    const p = y * width + x; next[p] = 140; rgb[p * 3] = 200; rgb[p * 3 + 1] = 120; rgb[p * 3 + 2] = 90;
  }
  const icon = 88 * width + 30; next[icon] = 230; rgb.fill(230, icon * 3, icon * 3 + 3);
  const mask = surfaceMask(next, baseline, screen, screen, width, height, rgb);
  expect(mask[108 * width + 65]).toBe(0); expect(mask[icon]).toBe(255); expect(mask[200 * width + 100]).toBe(0);
});
function origin() {
  const root = directory(), clip = join(root, "clip.mp4"), reference = join(root, "reference.jpg");
  const promptFile = join(root, "prompt.txt"); writeFileSync(promptFile, "原提交正文");
  writeFileSync(clip, "真实字节夹具，不是可播放视频"); writeFileSync(reference, "原来源");
  const sourceHash = productionHash({ film: "original" }), requestSha256 = productionHash({ request: "original" });
  const lineage = createLineageReceipt({ projectId: "p", shotId: "s", sourceHash, runId: "r", stage: "identity-fact", status: "failed",
    recipe: {}, inputs: [reference], outputs: [clip] });
  return { projectId: "p", shotId: "s", sourceHash, clip, expectedRequestSha256: requestSha256,
    promptFile, submission: createLineageReceipt({ projectId: "p", shotId: "s", sourceHash, runId: "r", stage: "gate:material-generate:submit",
      status: "passed", recipe: {}, inputs: [reference, promptFile], outputs: [] }),
    previous: { ok: false, degraded: false, verdict: verdict(false), lineage },
    taskReceipt: { schemaVersion: "workloom.video-task-receipt/v1", projectId: "p", shotId: "s", taskId: "once", state: "succeeded", requestSha256 } };
}
it("读取真实失败与成功任务的绑定字节；修复资格不把原拒绝改成通过", () => {
  const input = origin(); expect(assertSurfaceRepairOrigin(input)).toBe("once"); expect(input.previous.verdict.approved).toBe(false);
});
it.each(["project", "shot", "source", "request", "clip", "reference", "prompt", "submission", "task"])("%s变化或缺资格拒绝本地修复", field => {
  const input = origin();
  if (field === "project") input.projectId = "other";
  if (field === "shot") input.shotId = "other";
  if (field === "source") input.sourceHash = productionHash("changed");
  if (field === "request") input.expectedRequestSha256 = productionHash("changed");
  if (field === "clip") writeFileSync(input.clip, "changed");
  if (field === "reference") writeFileSync(input.previous.lineage.inputs[0]!.path, "changed");
  if (field === "prompt") writeFileSync(input.promptFile, "changed");
  if (field === "submission") input.submission.status = "failed";
  if (field === "passed") input.previous.verdict = verdict(true);
  if (field === "unverified") input.previous.verdict.degraded = true;
  if (field === "task") input.taskReceipt.state = "submitted";
  expect(() => assertSurfaceRepairOrigin(input)).toThrow(/SURFACE_REPAIR_UNVERIFIED/);
});
it("复读后期副本完整裁决和字节，不因读取失败或旧配方变化伪造通过", () => {
  const base = origin(), row = { ok: true, degraded: false, artifact: base.clip, verdict: verdict(true, [base.clip]),
    lineage: createLineageReceipt({ projectId: "p", shotId: "s", sourceHash: base.sourceHash, runId: "r", stage: "surface-repair",
      status: "passed", recipe: { version: "old-source-component" }, inputs: [base.promptFile], outputs: [base.clip] }) };
  const input = { projectId: "p", shotId: "s", sourceHash: base.sourceHash, row };
  expect(assertReviewedSurfaceRepair(input)).toBe(base.clip);
  expect(() => assertReviewedSurfaceRepair({ ...input, sourceHash: productionHash("other") })).toThrow("来源不符");
  expect(() => assertReviewedSurfaceRepair({ ...input, row: { ...row, verdict: verdict(false, [base.clip]) } })).not.toThrow();
  expect(() => assertReviewedSurfaceRepair({ ...input, row: { ...row, verdict: null } })).not.toThrow();
  writeFileSync(base.clip, "changed"); expect(() => assertReviewedSurfaceRepair(input)).toThrow("已改变");
});

function qualified() {
  const base = origin(), clip = join(directory(), "derived.mp4"), body = { model: "offline-fixture", text: "same paid request" };
  writeFileSync(clip, "明确派生字节夹具，不是可播放视频");
  const contractHash = productionHash({ current: "full shot contract" });
  const evidence = { taskId: "once", original: base.clip, originalSha256: fingerprintArtifact(base.clip).sha256 };
  const repair = { ok: true, degraded: false, artifact: clip, verdict: verdict(true, [clip]), evidence,
    lineage: createLineageReceipt({ projectId: "p", shotId: "s", sourceHash: base.sourceHash, runId: "old", stage: "surface-repair",
      status: "passed", recipe: {}, inputs: [base.clip, base.promptFile], outputs: [clip] }) };
  const identity = { ok: true, degraded: false, artifact: clip, verdict: { ...verdict(true, [clip]), contractHash }, evidence,
    lineage: createLineageReceipt({ projectId: "p", shotId: "s", sourceHash: base.sourceHash, runId: "old", stage: "identity-fact",
      status: "passed", recipe: {}, inputs: [clip, base.promptFile], outputs: [clip] }) };
  const receiptRoot = directory();
  const receiptFile = join(receiptRoot, `${productionHash({ projectId: "p", shotId: "s" })}.json`);
  writeFileSync(receiptFile, JSON.stringify({ ...base.taskReceipt, requestSha256: productionHash(body), result: { taskId: "once", url: "https://explicit-test.invalid/video", lastFrame: null } }));
  return { projectId: "p", shotId: "s", sourceHash: base.sourceHash, contractHash, clip, receiptRoot, receiptFile, body, repair, identity };
}
it("当前完整合同+同一派生字节+成功请求只读资格；返回原片和任务、不产生新的供应商请求", async () => {
  const input = qualified();
  expect(() => assertSurfaceIdentityQualification({ ...input, row: input.identity })).not.toThrow();
  const result = await qualifyReviewedSurfacePost(input);
  expect(result).toMatchObject({ clip: input.clip, taskId: "once", original: input.repair.evidence.original });
  expect(Object.keys(result)).not.toContain("url");
});
it.each(["source", "clip", "original", "task", "request", "missing-receipt", "unfinished"])("后期资格%s缺失/改变不能复用旧通过，也不能提交新的任务", async field => {
  const input = qualified();
  if (field === "latest-rejected") input.identity.verdict = { ...input.identity.verdict, approved: false, status: "failed" };
  if (field === "contract") input.contractHash = productionHash("changed");
  if (field === "source") input.sourceHash = productionHash("changed");
  if (field === "clip") writeFileSync(input.clip, "changed");
  if (field === "original") writeFileSync(input.repair.evidence.original, "changed");
  if (field === "task") input.repair.evidence.taskId = "other-paid-task";
  if (field === "request") input.body.text = "new request";
  if (field === "missing-receipt") rmSync(input.receiptFile);
  if (field === "unfinished") {
    const value = JSON.parse(readFileSync(input.receiptFile, "utf8")); value.state = "submitted"; writeFileSync(input.receiptFile, JSON.stringify(value));
  }
  await expect(qualifyReviewedSurfacePost(input)).rejects.toThrow();
});

it("历史身份/服装/分数或空身份裁决不拦已成功字节进入本地后期", async () => {
  const input = qualified();
  input.identity.verdict = { ...input.identity.verdict, approved: false, score: 0, status: "failed" };
  input.contractHash = productionHash("changed creative component");
  expect(() => assertSurfaceIdentityQualification({ ...input, row: input.identity })).not.toThrow();
  expect(await qualifyReviewedSurfacePost(input)).toMatchObject({ clip: input.clip, taskId: "once" });
  const previous = origin(); previous.previous.verdict = verdict(true);
  expect(assertSurfaceRepairOrigin(previous)).toBe("once");
});

const ffmpeg = process.env.WL_FFMPEG ?? "ffmpeg", ffprobe = process.env.WL_FFPROBE ?? "ffprobe";
const hasMedia = spawnSync(ffmpeg, ["-version"]).status === 0 && spawnSync(ffprobe, ["-version"]).status === 0;
it.skipIf(!hasMedia)("真实媒体：局部虚化保持帧数/原音频/区域外，拒绝未经实际定位审批或覆盖原片", () => {
  const root = directory(), clip = join(root, "original.mp4"), output = join(root, "repaired.mp4");
  const filters = "drawbox=x=40:y=160:w=100:h=64:color=0x202020:t=fill,drawbox=x=50:y=175:w=50:h=4:color=white:t=fill";
  execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=0xdddddd:s=320x568:r=24:d=1", "-f", "lavfi", "-i", "sine=frequency=880:duration=1",
    "-vf", filters, "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip]);
  const sha = fingerprintArtifact(clip).sha256;
  const inspected = inspectSurfaceRepair({ ffmpeg, ffprobe, input: clip, directory: join(root, "evidence"), projectId: "p", shotId: "s", taskId: "once", sourceHash: productionHash("source") });
  expect(inspected.plan.frames).toHaveLength(24);
  expect(() => executeSurfaceRepair({ ffmpeg, ffprobe, ...inspected, output, localization: verdict(false) })).toThrow("定位计划与实际输入字节不一致");
  const localization = verdict(true, [inspected.planFile, ...inspected.previews]);
  const repaired = executeSurfaceRepair({ ffmpeg, ffprobe, ...inspected, output, localization });
  expect(repaired.outsideMeanError).toBeLessThan(3); expect(repaired.audioSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(fingerprintArtifact(clip).sha256).toBe(sha); expect(repaired.sha256).not.toBe(sha);
  expect(() => executeSurfaceRepair({ ffmpeg, ffprobe, ...inspected, output: clip, localization })).toThrow("禁止覆盖");
  expect(() => executeSurfaceRepair({ ffmpeg, ffprobe, ...inspected, output, localization })).toThrow("禁止覆盖");
  writeFileSync(inspected.plan.maskFile, readFileSync(inspected.plan.maskFile).fill(0));
  expect(() => executeSurfaceRepair({ ffmpeg, ffprobe, ...inspected, output: join(root, "changed.mp4"), localization })).toThrow("mask变动");
}, 120_000);
