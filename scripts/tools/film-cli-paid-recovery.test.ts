import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporary: string[] = [];
const ffmpeg = process.env.WL_FFMPEG ?? "ffmpeg";
const ffprobe = process.env.WL_FFPROBE ?? "ffprobe";
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });
type Row = Record<string, any>;
type Kind = "image" | "video";
type Mode = "ok" | "download-loss" | "ack-loss";

/** This child runs the actual CLI. Every network operation is intercepted before import. */
const bootstrap = `
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const receipts = () => {
  const directory = config.kind === "image" ? join(config.receiptRoot, "images") : join(config.receiptRoot, "videos", "v2");
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(name => name.endsWith(".json")).map(name => JSON.parse(readFileSync(join(directory, name), "utf8")));
};
globalThis.fetch = async (input, options = {}) => {
  const url = String(input), method = options.method ?? "GET";
  const event = { url, method, receipts: receipts().map(value => ({ state: value.state, taskId: value.taskId, resultUrl: value.result?.url, identity: value.identity })) };
  appendFileSync(config.calls, JSON.stringify(event) + "\\n");
  if (url === "https://fixture.invalid/api/images/generations" && method === "POST" && config.kind === "image") {
    if (config.mode === "ack-loss") throw new Error("INJECTED_PROVIDER_ACK_LOSS");
    return Response.json({ data: [{ url: "https://fixture.invalid/result/image.png" }] });
  }
  if (url === "https://fixture.invalid/api/contents/generations/tasks" && method === "POST" && config.kind === "video") {
    if (config.mode === "ack-loss") throw new Error("INJECTED_PROVIDER_ACK_LOSS");
    return Response.json({ id: "fixture-task-1" });
  }
  if (url === "https://fixture.invalid/api/contents/generations/tasks/fixture-task-1" && method === "GET" && config.kind === "video") {
    return Response.json({ status: "succeeded", content: { video_url: "https://fixture.invalid/result/video.mp4" } });
  }
  if (url === "https://fixture.invalid/result/" + (config.kind === "image" ? "image.png" : "video.mp4") && method === "GET") {
    if (config.mode === "download-loss") throw new Error("INJECTED_DOWNLOAD_LOSS");
    return new Response(readFileSync(config.media));
  }
  throw new Error("UNEXPECTED_NETWORK_FORBIDDEN: " + method + " " + url);
};
process.argv = [process.argv[0], config.cli, ...config.args];
await import(pathToFileURL(config.cli).href);
`;

function runMedia(args: string[]): void {
  const result = spawnSync(ffmpeg, ["-hide_banner", "-v", "error", ...args], { encoding: "utf8", timeout: 20_000 });
  if (result.error || result.status !== 0) throw new Error(`Fixture generation failed: ${result.error ?? result.stderr}`);
}
function fixture(kind: Kind) {
  const dir = mkdtempSync(join(tmpdir(), "film-cli-paid-recovery-")); temporary.push(dir);
  const media = join(dir, kind === "image" ? "provider.png" : "provider.mp4");
  if (kind === "image") runMedia(["-f", "lavfi", "-i", "color=green:size=16x16", "-frames:v", "1", media]);
  else runMedia(["-f", "lavfi", "-i", "testsrc2=size=96x64:rate=30", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", media]);
  const photo = join(dir, "reference.png");
  if (kind === "video") runMedia(["-f", "lavfi", "-i", "testsrc=size=256x256,noise=alls=80:allf=u,format=rgb24", "-frames:v", "1", photo]);
  const shotsFile = join(dir, "shots.json"), project = `recovery-${kind}`;
  const shot = { shotId: "EMPTY", duration: 4, scene: "无人办公室空镜，室内自然光，桌面和背景保持清晰", noPerson: true,
    ...(kind === "video" ? { photo, materialUsage: "generation-reference" } : {}) };
  writeFileSync(shotsFile, JSON.stringify({ title: "完整镜头故障恢复", shots: [shot] }));
  const receiptRoot = join(dir, "stable-receipts"), calls = join(dir, "calls.jsonl"), boot = join(dir, "bootstrap.mjs");
  writeFileSync(boot, bootstrap);
  const keys = join(dir, "fixture.env");
  // These are fixture values, never live credentials. The network interceptor permits only fixture.invalid.
  writeFileSync(keys, "ARK_BASE_URL=https://fixture.invalid/api\nARK_API_KEY=fixture-not-a-real-key\n");
  const readRows = (file: string): Row[] => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const run = (workName: string, mode: Mode) => {
    const workDir = join(dir, workName), config = join(dir, `${workName}-config.json`);
    const args = ["--shots", shotsFile, "--project", project, "--work-dir", workDir, "--out", join(workDir, "out"),
      "--keys-file", keys, "--library", join(dir, "no-characters"), "--route-kind", "narrative", "--platform", "youtube",
      "--generation-receipt-root", receiptRoot, "--stages", kind === "image" ? "plates" : "material-gen", "--no-resume", "--max-attempts", "1"];
    writeFileSync(config, JSON.stringify({ kind, mode, receiptRoot, calls, media, cli: join(root, "scripts/tools/full-chain-film.mts"), args }));
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/KEY|TOKEN|SECRET|PASSWORD|^FILM_WORKER_MODE$/i.test(key)) delete env[key];
    env.WL_FFMPEG = ffmpeg; env.WL_FFPROBE = ffprobe; env.WORKLOOM_VIDEO_ARTIFACT_ROOT = dir;
    const result = spawnSync(process.execPath, ["--import", "tsx", boot, config], { cwd: root, encoding: "utf8", timeout: 35_000, env });
    return { result, workDir, diagnostic: `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`,
      rows: () => readRows(join(workDir, "logs", project, "stages.jsonl")) };
  };
  return { dir, project, media, receiptRoot, shotsFile, run, calls: () => readRows(calls),
    postCalls: () => readRows(calls).filter(value => value.method === "POST") };
}
function sha(file: string): string { return createHash("sha256").update(readFileSync(file)).digest("hex"); }
function requiredRow(rows: Row[], predicate: (row: Row) => boolean): Row {
  const row = rows.find(predicate);
  if (!row) throw new Error("Expected intercepted network operation is missing");
  return row;
}

describe("实际制片CLI的持久受理与原片保留", () => {
  it("关键帧下载失败后换运行目录，从已存URL恢复且不重新付费；默认接收小图", () => {
    const setup = fixture("image");
    const first = setup.run("first", "download-loss");
    expect(first.result.status, first.diagnostic).not.toBe(0);
    expect(first.rows().filter(row => row.stage === "keyframe").at(-1)).toMatchObject({ ok: false, evidence: { error: "INJECTED_DOWNLOAD_LOSS" } });
    const post = setup.postCalls(); expect(post).toHaveLength(1);
    expect(post[0].receipts).toEqual([expect.objectContaining({ state: "submitting", identity: expect.objectContaining({ projectId: setup.project, slotId: "plate:EMPTY", provider: "ark", endpoint: post[0].url }) })]);
    const get = requiredRow(setup.calls(), row => row.url.endsWith("/result/image.png"));
    expect(get.receipts).toEqual([expect.objectContaining({ state: "accepted", resultUrl: get.url })]);
    const second = setup.run("second", "ok");
    expect(second.result.status, second.diagnostic).toBe(0);
    expect(setup.postCalls()).toHaveLength(1);
    expect(second.rows().filter(row => row.stage === "keyframe").at(-1)).toMatchObject({ ok: true, verdict: { via: "deterministic", score: null, degraded: false } });
    const delivered = join(second.workDir, "plates", setup.project, "EMPTY-plate.png");
    expect(sha(delivered)).toBe(sha(setup.media));
    expect(setup.calls().every(row => row.url.startsWith("https://fixture.invalid/"))).toBe(true);
  }, 85_000);

  it.each(["image", "video"] as const)("%s提交响应丢失时，重新启动不产生第二次POST", kind => {
    const setup = fixture(kind);
    const first = setup.run("first", "ack-loss");
    expect(first.result.status, first.diagnostic).not.toBe(0);
    expect(first.rows().some(row => row.ok === false && String(row.evidence?.error).includes("INJECTED_PROVIDER_ACK_LOSS"))).toBe(true);
    const second = setup.run("second", "ok");
    expect(second.result.status, second.diagnostic).not.toBe(0);
    expect(second.rows().some(row => /SUBMISSION_UNKNOWN/.test(String(row.evidence?.error)))).toBe(true);
    expect(setup.postCalls()).toHaveLength(1);
    expect(setup.calls()).toHaveLength(1);
  }, 85_000);

  it("视频已成功但下载失败时，换目录取原任务；计划4秒不改变实际1秒原片", () => {
    const setup = fixture("video");
    const first = setup.run("first", "download-loss");
    expect(first.result.status, first.diagnostic).not.toBe(0);
    const post = setup.postCalls(); expect(post).toHaveLength(1);
    expect(post[0].receipts).toEqual([expect.objectContaining({ state: "submitting", identity: expect.objectContaining({ projectId: setup.project, shotId: "EMPTY", endpoint: post[0].url, body: expect.objectContaining({ duration: 4 }) }) })]);
    const poll = requiredRow(setup.calls(), row => row.url.endsWith("/fixture-task-1"));
    expect(poll.receipts).toEqual([expect.objectContaining({ state: "submitted", taskId: "fixture-task-1" })]);
    const get = requiredRow(setup.calls(), row => row.url.endsWith("/result/video.mp4"));
    expect(get.receipts).toEqual([expect.objectContaining({ state: "succeeded", taskId: "fixture-task-1", resultUrl: get.url })]);
    const second = setup.run("second", "ok");
    expect(second.result.status, second.diagnostic).toBe(0);
    expect(setup.postCalls()).toHaveLength(1);
    const clip = join(second.workDir, "clips", setup.project, "EMPTY.mp4");
    const raw = join(second.workDir, "clips", setup.project, "EMPTY.raw.mp4");
    expect(sha(clip)).toBe(sha(setup.media)); expect(sha(raw)).toBe(sha(setup.media));
    const probe = spawnSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "json", clip], { encoding: "utf8", timeout: 5_000 });
    expect(probe.status, probe.stderr).toBe(0);
    expect(Number(JSON.parse(probe.stdout).format.duration)).toBeLessThan(1.1);
    expect(second.rows().filter(row => row.stage === "material-gen").at(-1)).toMatchObject({ ok: true, evidence: { taskId: "fixture-task-1", qualityReviewed: false, normalized: { factor: 1, sourceTiming: "preserved" } } });
  }, 85_000);

  it.each(["image", "video"] as const)("%s旧产物缺受理记录时，不因为换目录或禁用缓存而重新付费", kind => {
    const setup = fixture(kind);
    const legacy = join(setup.dir, "second", kind === "image" ? "plates" : "clips", setup.project);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, kind === "image" ? "EMPTY-plate.png" : "EMPTY.raw.mp4"), readFileSync(setup.media));
    const attempt = setup.run("second", "ok");
    expect(attempt.result.status, attempt.diagnostic).not.toBe(0);
    expect(attempt.rows().some(row => /LEGACY_RECEIPT_REQUIRED/.test(String(row.evidence?.error)))).toBe(true);
    expect(setup.calls()).toHaveLength(0);
  }, 85_000);
});
