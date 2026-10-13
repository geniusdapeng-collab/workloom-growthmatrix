/** Actual current matrix CLI, actual local frames/audio, zero provider or model calls. */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspectGenerationManifest } from "./generation-quality.mjs";
const repo = fileURLToPath(new URL("../../", import.meta.url));
const ffmpeg = process.env.WL_FFMPEG || "ffmpeg", ffprobe = process.env.WL_FFPROBE || "ffprobe";
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

test("matrix current full CLI trims the provider original at authored intervals before any retime, protects speech and publishes 165 actual frames", { timeout: 150000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "matrix-original-rhythm-")));
  const project = "matrix-native-rhythm", work = path.join(root, "work"), out = path.join(root, "out");
  const source = path.join(root, "source.json"), keys = path.join(root, "empty.env"), trace = path.join(root, "operations.jsonl");
  const plan = { profile: "fast-cut", segments: [
    { id: "detail", sourceId: "s1", inSeconds: 1, outSeconds: 1.5, role: "fast", cutReason: "latch releases", protectedRanges: [{ inSeconds: 1, outSeconds: 1.5, kind: "speech", reason: "entire authored phrase" }] },
    { id: "layout", sourceId: "s2", inSeconds: 0, outSeconds: 2, role: "hold", cutReason: "read room layout" },
    { id: "tone", sourceId: "s3", inSeconds: 0, outSeconds: 3, role: "breath", cutReason: "room tone" },
  ] };
  const document = { title: "原片区间节奏验收", aspect: "16:9", resolution: "720p", durationSeconds: 5.5,
    eraProfile: { storyDate: "2026-10-14", devicePolicy: "story-compatible" }, rhythmPlan: plan,
    shots: [0.5, 2, 3].map((duration, index) => ({ shotId: `s${index + 1}`, duration, scene: "testsrc2 moving fixture",
      dialogue: index === 0 ? [{ text: "完整短句" }] : [],
      ...(index === 0 ? { protectedRanges: [{ inSeconds: 1, outSeconds: 1.5, kind: "speech", reason: "entire authored phrase" }] } : {}) })) };
  const originals = [];
  try {
    fs.writeFileSync(source, `${JSON.stringify(document, null, 2)}\n`); fs.writeFileSync(keys, "");
    const clipDir = path.join(work, "clips", project); fs.mkdirSync(clipDir, { recursive: true });
    for (const [index, shot] of document.shots.entries()) {
      const file = path.join(clipDir, `${shot.shotId}.raw.mp4`);
      execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=4",
        "-f", "lavfi", "-i", `aevalsrc=if(lt(t\\,1)\\,sin(2*PI*440*t)\\,sin(2*PI*${880 + index * 220}*t)):s=48000:d=4`,
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file], { timeout: 30000 });
      originals.push({ file, sha256: hash(file) });
    }
    const setup = `import fs from 'node:fs';import path from 'node:path';
import {productionHash,createLineageReceipt} from ${JSON.stringify(pathToFileURL(path.join(repo, "packages/video-studio/src/production-lineage.ts")).href)};
import {loadOrCreateFilmAuthorContext} from ${JSON.stringify(pathToFileURL(path.join(repo, "packages/video-studio/src/film-contracts.ts")).href)};
import {videoTaskReceiptPath} from ${JSON.stringify(pathToFileURL(path.join(repo, "packages/video-studio/src/video-task-receipt.ts")).href)};
const source=${JSON.stringify(source)},work=${JSON.stringify(work)},project=${JSON.stringify(project)}, originals=${JSON.stringify(originals)};
const document=JSON.parse(fs.readFileSync(source,'utf8'));
const logDir = path.join(work, "logs", project), contextFile = path.join(logDir, "project-context.json");
    const context = loadOrCreateFilmAuthorContext({ path: contextFile, projectId: project, eraProfile: document.eraProfile });
    const { shots, durationSeconds, ...common } = document;
    const oldRows = shots.map((shot, index) => {
      const sourceHash = productionHash({ source: { ...common, shot }, brief: null, sceneBible: null,
        eraProfile: context.eraProfile, aspect: "16:9", resolution: "720p", fps: 30 });
      const lineage = createLineageReceipt({ projectId: project, sourceHash, runId: "cached-provider-original", stage: "shot", shotId: shot.shotId,
        recipe: { component: "obsolete-quality-version" }, status: "failed", inputs: [source, contextFile], outputs: [originals[index].file] });
      const taskId = \`provider-success-\${shot.shotId}\`;
      const receiptFile = videoTaskReceiptPath(path.join(work, "render-task-receipts"), project, shot.shotId);
      fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
      fs.writeFileSync(receiptFile, JSON.stringify({ schemaVersion: "workloom.video-task-receipt/v1", projectId: project, shotId: shot.shotId,
        requestSha256: "a".repeat(64), state: "succeeded", taskId, result: { taskId, url: "https://provider.invalid/offline.mp4", lastFrame: null } }));
      return { at: "2026-10-13T00:00:00.000Z", stage: "shot", shotId: shot.shotId, invoked: true, ok: false,
        cached: false, degraded: false, attempt: 1, ms: 1, artifact: originals[index].file,
        evidence: { taskId, providerStatus: "succeeded", qualityScore: 0 }, verdict: { approved: false, score: 0 }, lineage };
    });
    const oldBytes = oldRows.map(row => JSON.stringify(row)).join("\\n") + "\\n";
    fs.writeFileSync(path.join(logDir, "stages.jsonl"), oldBytes);
    console.log(JSON.stringify({ logDir, oldBytes }));
`;
    const prepared = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", setup],
      { cwd: repo, encoding: "utf8", timeout: 30000 });
    assert.equal(prepared.status, 0, prepared.stderr); assert.equal(prepared.error, undefined);
    const { logDir, oldBytes } = JSON.parse(prepared.stdout.trim());
    const preload = path.join(root, "no-network.mjs");
    fs.writeFileSync(preload, `import fs from 'node:fs';import cp from 'node:child_process';import http from 'node:http';import https from 'node:https';import {syncBuiltinESMExports} from 'node:module';
const write=x=>fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(x)+'\\n');const deny=()=>{write({kind:'network'});throw new Error('NETWORK_OR_MODEL_MUST_NOT_RUN')};globalThis.fetch=deny;http.request=deny;http.get=deny;https.request=deny;https.get=deny;
for(const name of ['spawn','spawnSync','execFileSync']){const original=cp[name];cp[name]=function(command,args,...rest){write({kind:'process',command:String(command),args:Array.isArray(args)?args:[]});return original.call(this,command,args,...rest)}}syncBuiltinESMExports();`);
    const argv = ["--import", "tsx", path.join(repo, "scripts/tools/full-chain-film.mts"), "--shots", source, "--project", project,
      "--work-dir", work, "--out", out, "--keys-file", keys, "--aspect", "16:9", "--fps", "30", "--stages", "compose,master", "--xfade", "0", "--no-sfx"];
    const result = spawnSync(process.execPath, argv, { cwd: repo, encoding: "utf8", timeout: 120000, maxBuffer: 24 << 20,
      env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, WL_FFMPEG: ffmpeg, WL_FFPROBE: ffprobe,
        WORKLOOM_POST_FFMPEG_PATH: ffmpeg, WORKLOOM_POST_FFPROBE_PATH: ffprobe, WORKLOOM_COLOR_FFMPEG_PATH: ffmpeg,
        WORKLOOM_COLOR_FFPROBE_PATH: ffprobe, ARK_API_KEY: "", VOLCENGINE_ARK_API_KEY: "" } });
    const operations = fs.existsSync(trace) ? fs.readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(row => JSON.parse(row)) : [];
    assert.equal(operations.filter(row => row.kind === "network").length, 0);
    assert.equal(result.status, 0, `${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`);
    for (const original of originals) assert.equal(hash(original.file), original.sha256);
    assert.ok(fs.readFileSync(path.join(logDir, "stages.jsonl"), "utf8").startsWith(oldBytes));
    const summary = JSON.parse(fs.readFileSync(path.join(logDir, "stage-summary.json"), "utf8"));
    const receiptRecord = summary.records.find(row => row.stage === "rhythm-edit" && row.ok);
    assert.ok(receiptRecord, "actual interval edit must write its current stage receipt");
    const rhythm = JSON.parse(fs.readFileSync(receiptRecord.artifact, "utf8"));
    assert.deepEqual(rhythm.originals.map(entry => entry.sha256), originals.map(entry => entry.sha256));
    assert.deepEqual(rhythm.outputs.map(entry => entry.media.videoSeconds), [0.5, 2, 3]);
    assert.equal(rhythm.originalSpeed, 1); assert.equal(rhythm.pictureAndAudioSameRanges, true);
    assert.deepEqual(receiptRecord.evidence.actualDurationsSeconds, [0.5, 2, 3]);
    const pointer = JSON.parse(fs.readFileSync(path.join(out, "current.json"), "utf8"));
    const manifestFile = path.join(pointer.releaseDir, `${project}-delivery-manifest.json`);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    const report = await inspectGenerationManifest({ root: pointer.releaseDir, manifest, bins: { ffmpeg, ffprobe } });
    assert.equal(report.passed, true); assert.equal(report.paidCalls, 0);
    const finalFile = path.resolve(pointer.releaseDir, manifest.deliverable.path);
    const info = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", finalFile], { encoding: "utf8" }));
    const video = info.streams.find(stream => stream.codec_type === "video");
    assert.equal(Number(video.nb_read_frames), 165); assert.equal(video.avg_frame_rate, "30/1");
    assert.equal(video.width, 320); assert.equal(video.height, 180);
    const audio = execFileSync(ffmpeg, ["-v", "error", "-ss", "0.05", "-t", "0.35", "-i", finalFile,
      "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"], { timeout: 30000 });
    const amplitude = frequency => {
      let sine = 0, cosine = 0; const count = audio.length / 4;
      for (let index = 0; index < count; index++) {
        const sample = audio.readFloatLE(index * 4), phase = 2 * Math.PI * frequency * index / 48000;
        sine += sample * Math.sin(phase); cosine += sample * Math.cos(phase);
      }
      return 2 * Math.hypot(sine, cosine) / count;
    };
    const authored880Hz = amplitude(880), excluded440Hz = amplitude(440);
    assert.ok(authored880Hz > 0.2 && authored880Hz > excluded440Hz * 10,
      `first segment must contain original 1.0–1.5s marker, not earlier source audio: ${authored880Hz}/${excluded440Hz}`);
    execFileSync(ffmpeg, ["-v", "error", "-i", finalFile, "-f", "null", "-"], { timeout: 30000 });
    assert.equal(operations.some(row => row.kind === "process" && row.args.some(arg => typeof arg === "string" && /setpts=PTS\*|atempo=/.test(arg))), false,
      "declared source-interval edits must reach the original source before any speed transform");
    console.info("MATRIX_ORIGINAL_RHYTHM_EVIDENCE", JSON.stringify({ argv, paidCalls: 0, networkCalls: 0, sourceHashes: originals.map(row => row.sha256),
      durations: rhythm.outputs.map(entry => entry.media.videoSeconds), videoFrames: Number(video.nb_read_frames), fps: video.avg_frame_rate, technicalPassed: report.passed, authored880Hz, excluded440Hz }));
  } finally { if (process.env.WORKLOOM_KEEP_RHYTHM_FIXTURE !== "1") fs.rmSync(root, { recursive: true, force: true }); }
});
