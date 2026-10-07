import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filmGenerationReceiptRoots, hasPriorFilmGeneration } from "./film-generation-receipts.js";
import { resumeOrSubmitImageTask } from "./image-task-receipt.js";
import { resumeOrSubmitVideoTask } from "./video-task-receipt.js";
const dirs: string[] = [];
const fixture = () => { const root = mkdtempSync(join(tmpdir(), "film-generation-")); dirs.push(root); return root; };
afterEach(() => dirs.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
it("changing a work directory or delivery path does not change the paid receipt root", () => {
  const root = fixture();
  const a = filmGenerationReceiptRoots({ repoRoot: root, workDir: join(root, "attempt-1") });
  const b = filmGenerationReceiptRoots({ repoRoot: root, workDir: join(root, "attempt-2") });
  expect(a.imageRoot).toBe(b.imageRoot); expect(a.videoRoot).toBe(b.videoRoot);
  const override = filmGenerationReceiptRoots({ repoRoot: root, workDir: root, artifactRoot: join(root, "archive") });
  expect(override.root).toBe(join(root, "archive/output/generation-receipts"));
});
it("uses exactly one image POST across fresh work directories, and refuses a lost ACK on restart", async () => {
  const root = fixture(), options = { repoRoot: root, workDir: join(root, "attempt-1") };
  let posts = 0;
  const image = { projectId: "P1", slotId: "plate:S1", provider: "ark", endpoint: "https://provider.invalid/images", body: { model: "m", prompt: "full body" },
    submit: async () => { posts++; return { url: "https://provider.invalid/image.jpg" }; } };
  await resumeOrSubmitImageTask({ ...image, root: filmGenerationReceiptRoots(options).imageRoot });
  await resumeOrSubmitImageTask({ ...image, root: filmGenerationReceiptRoots({ ...options, workDir: join(root, "attempt-2") }).imageRoot });
  expect(posts).toBe(1);
  const failed = { ...image, slotId: "plate:S2", submit: async () => { posts++; throw new Error("response lost"); } };
  await expect(resumeOrSubmitImageTask({ ...failed, root: filmGenerationReceiptRoots(options).imageRoot })).rejects.toThrow("response lost");
  await expect(resumeOrSubmitImageTask({ ...failed, root: filmGenerationReceiptRoots({ ...options, workDir: join(root, "attempt-3") }).imageRoot })).rejects.toThrow("UNKNOWN");
  expect(posts).toBe(2);
});
it("uses the same accepted video task across fresh work directories", async () => {
  const root = fixture(), scopes = [1, 2].map(index => filmGenerationReceiptRoots({ repoRoot: root, workDir: join(root, `attempt-${index}`) }));
  let posts = 0, polls = 0;
  const input = { projectId: "P1", shotId: "S1", body: { model: "m", duration: 5 }, provider: "ark", endpoint: "https://provider.invalid/video",
    transport: { submit: async () => { posts++; return { ok: true, status: 200, text: '{"id":"task-1"}' }; },
      poll: async () => { polls++; return { ok: true, status: 200, text: '{"status":"succeeded","content":{"video_url":"https://provider.invalid/video.mp4"}}' }; } }, pollIntervalMs: 0 };
  for (const scope of scopes) await resumeOrSubmitVideoTask({ ...input, root: scope.videoRoot, legacyRoots: scope.legacyVideoRoots });
  expect(posts).toBe(1); expect(polls).toBe(1);
});
it("recognizes prior metadata and dispatches in supplied legacy directories without confusing S1 and S10", () => {
  const root = fixture(), legacy = join(root, "legacy"), options = { projectId: "P1", shotId: "S1", kind: "image" as const, workDirs: [legacy] };
  mkdirSync(join(legacy, "plates/P1"), { recursive: true }); writeFileSync(join(legacy, "plates/P1/S10-plate.png"), "other shot");
  expect(hasPriorFilmGeneration(options)).toBe(false);
  writeFileSync(join(legacy, "plates/P1/S1.hosted-url.json"), "prior URL metadata"); expect(hasPriorFilmGeneration(options)).toBe(true);
  const history = join(legacy, "logs/P1"); mkdirSync(history, { recursive: true });
  writeFileSync(join(history, "stages.jsonl"), JSON.stringify({ stage: "material-gen", shotId: "S1", invoked: true, ok: false }) + "\n");
  expect(hasPriorFilmGeneration({ ...options, kind: "video" })).toBe(true);
  writeFileSync(join(history, "stages.jsonl"), "corrupt unknown dispatch evidence\n");
  expect(() => hasPriorFilmGeneration({ ...options, kind: "video" })).toThrow("UNREADABLE");
});
