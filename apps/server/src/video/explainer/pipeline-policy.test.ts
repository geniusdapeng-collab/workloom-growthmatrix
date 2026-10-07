import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runExplainerPipeline, type ExplainerRunInput, type StageEvent } from "./pipeline.js";

const seam = vi.hoisted(() => ({ align: vi.fn(), build: vi.fn(), submit: vi.fn(), poll: vi.fn(), deliver: vi.fn() }));
vi.mock("./asr-aligner.js", async importOriginal => ({ ...(await importOriginal<typeof import("./asr-aligner.js")>()), alignTimestamps: seam.align }));
vi.mock("./card-registry.js", () => ({ buildCardRegistry: () => ({ entries: [], bySlug: new Map() }) }));
vi.mock("./project-builder.js", () => ({ buildProject: seam.build, templateDirOf: () => "/not-used" }));
vi.mock("./shotbook.js", () => ({ validateShotbook: () => ({ ok: true, warnings: [], errors: [] }), generateShotbook: vi.fn(), shotbookFromPlan: vi.fn() }));
vi.mock("./deliver.js", () => ({ deliverFilm: seam.deliver }));
vi.mock("./remotion-provider.js", async importOriginal => ({
  ...(await importOriginal<typeof import("./remotion-provider.js")>()),
  RemotionProvider: class { submit = seam.submit; poll = seam.poll; },
}));

let root: string;
let input: ExplainerRunInput;
let events: StageEvent[];
beforeEach(() => {
  vi.clearAllMocks(); events = [];
  root = mkdtempSync(join(tmpdir(), "wl-explainer-resume-"));
  mkdirSync(join(root, "out")); mkdirSync(join(root, "remotion")); mkdirSync(join(root, "scripts"));
  const audio = join(root, "voice.wav"), video = join(root, "out", "v1.mp4");
  const ffmpeg = process.env.FFMPEG_PATH?.trim() || "ffmpeg";
  execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=32x32:r=30:d=0.3",
    "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", video]);
  execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=0.3", audio]);
  const preflight = join(root, "preflight-runner");
  writeFileSync(preflight, `#!${process.execPath}\nprocess.stdout.write('PASS prepared media\\n');\n`, { mode: 0o700 });
  const shot = { id: "s1", start: 0, end: 0.3, text: "你好。", card: "card-one", content: {}, replace: [], skin: {}, material: { kind: "文" as const }, sfx: [], notes: "" };
  writeFileSync(join(root, "remotion", "shots.json"), JSON.stringify([shot]));
  writeFileSync(join(root, "remotion", "cues.json"), "[]");
  const timestamps = { sr: 16000, total: 0.3, sentences: [{ i: 1, text: "你好。", start: 0, end: 0.3, asr: "你好", match: 1, ok: true, words: [] }] };
  seam.align.mockResolvedValue({ backend: "precomputed", precision: "word", total: 0.3, lowMatch: [], timestamps });
  seam.build.mockReturnValue({ jobDir: root, remotionDir: join(root, "remotion"), propsPath: "props", shotsPath: join(root, "remotion", "shots.json"),
    beatsPath: "beats", anchorsPath: "anchors", cuesPath: join(root, "remotion", "cues.json"), hostSrcByShot: {}, cards: ["card-one"], scenes: ["s1"], sfxFiles: [] });
  seam.submit.mockResolvedValue({ taskId: "fixture-local-render" });
  seam.poll.mockResolvedValue({ status: "succeeded", uri: video });
  seam.deliver.mockResolvedValue({ deliveryPath: video, rawPath: video, bytes: readFileSync(video).length, sha256: "fixture", measurement: {} });
  input = { taskId: "scope-1", jobDir: root, engineDir: root, templateDir: root,
    env: { ...process.env, TALKCRAFT_PYTHON: preflight }, script: { sentences: [{ i: 1, text: "你好。" }] }, audioPath: audio,
    semantics: { sentences: [{ i: 1, text: "你好。", sem: "论点", weight: "main", entities: [], need: "", shot: null }] },
    shotbook: { style: { domain: "fixture", tone: "plain", palette: { base: "#000", accent: "#fff", ink: "#fff" }, font: "sans", energy: "中" },
      rhythmTable: [{ shotId: "s1", hostForm: "无人物", container: "装框", card: "card-one" }], shots: [shot] },
    resumeFrom: "render", onStage: event => { events.push(event); } };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("explainer pipeline rendered resume", () => {
  it("an actual existing movie with different dimensions goes directly to postproduction without render or quality review", async () => {
    const before = readFileSync(join(root, "out", "v1.mp4"));
    const result = await runExplainerPipeline(input);
    expect(seam.submit).not.toHaveBeenCalled(); expect(seam.poll).not.toHaveBeenCalled();
    expect(seam.deliver).toHaveBeenCalledTimes(1);
    expect(result.qa).toMatchObject({ pass: false, accepted: true, reviewPolicy: "off", qualityReviewed: false });
    expect(events.filter(event => event.stageId === "machineGates").at(-1)).toMatchObject({ status: "skipped" });
    expect(readFileSync(result.renderVideoPath)).toEqual(before);
  });
  it("corrupted existing movie reports execution failure and never resubmits render", async () => {
    writeFileSync(join(root, "out", "v1.mp4"), "corrupted");
    await expect(runExplainerPipeline(input)).rejects.toThrow("禁止自动重渲");
    expect(seam.submit).not.toHaveBeenCalled(); expect(seam.deliver).not.toHaveBeenCalled();
  });
  it("postproduction failure preserves the movie and another continuation still does not render again", async () => {
    const before = readFileSync(join(root, "out", "v1.mp4"));
    seam.deliver.mockRejectedValueOnce(new Error("postproduction disk error"));
    await expect(runExplainerPipeline(input)).rejects.toThrow("disk error");
    await runExplainerPipeline(input);
    expect(seam.submit).not.toHaveBeenCalled(); expect(readFileSync(join(root, "out", "v1.mp4"))).toEqual(before);
  });
  it("an explicitly blocking unavailable check preserves the file without automatic rendering", async () => {
    const runner = join(root, "blocking-checker");
    writeFileSync(runner, `#!${process.execPath}\nif(process.argv[2].endsWith('preflight.py')){process.stdout.write('PASS prepared media\\n');}else{process.stderr.write('fixture checker unavailable\\n');process.exit(1);}\n`, { mode: 0o700 });
    await expect(runExplainerPipeline({ ...input, reviewPolicy: "blocking",
      env: { ...input.env, TALKCRAFT_PYTHON: runner } })).rejects.toThrow("机器闸未过");
    expect(seam.submit).not.toHaveBeenCalled(); expect(seam.deliver).not.toHaveBeenCalled();
  });
  it("invalid review policy is rejected before preparing audio, files or render", async () => {
    await expect(runExplainerPipeline({ ...input, reviewPolicy: "unknown" as "off" })).rejects.toThrow("POLICY_INVALID");
    expect(seam.build).not.toHaveBeenCalled(); expect(seam.submit).not.toHaveBeenCalled();
  });
});
