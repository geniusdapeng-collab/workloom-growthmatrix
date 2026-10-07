/** Original provider program bytes enter one official mix without signing or quality review.
 * Explicit stem bundles remain verified separately; this exercises the default byte authority.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { callTool, mix } from "./core.mjs";
import { describeAudioStemSources, renderAudioStems } from "./audio-stems.mjs";
import { audioStemReceiptPayload, createAudioStemReceiptVerifier } from "./audio-stems-trust.mjs";

const bins = {
  ffmpeg: process.env.WORKLOOM_POST_FFMPEG_PATH || process.env.WL_FFMPEG || "ffmpeg",
  ffprobe: process.env.WORKLOOM_POST_FFPROBE_PATH || process.env.WL_FFPROBE || "ffprobe"
};
const hasMedia = (() => {
  try {
    execFileSync(bins.ffmpeg, ["-version"], { stdio: "ignore" });
    execFileSync(bins.ffprobe, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const suite = hasMedia ? describe : describe.skip;
const encode = (args) => execFileSync(bins.ffmpeg, ["-hide_banner", "-v", "error", "-y", ...args], { timeout: 60000, stdio: "pipe" });

let root, source, music;

suite("配乐声明式直混（无签章签发者时的正常交付路径）", () => {
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "bgm-declared-"));
    source = path.join(root, "source.mp4");
    music = path.join(root, "music.wav");
    // Synthetic fixtures have no customer data. Quiet/black source content is not reviewed.
    encode(["-f", "lavfi", "-i", "color=c=black:s=320x240:d=3",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
      "-filter_complex", "[1:a]volume='if(between(t,1,2),0,1)':eval=frame[a]",
      "-map", "0:v", "-map", "[a]",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source]);
    encode(["-f", "lavfi", "-i", "sine=frequency=1760:duration=3", "-c:a", "pcm_s16le", music]);
  });

  it("无签发者 + 显式声明：直混出片，回执如实标注 original-program-bytes", async () => {
    const env = {
      ...process.env,
      /** 明确模拟"本机没有签发者" */
      WORKLOOM_AUDIO_STEM_SIGNING_SECRET: "",
      WORKLOOM_AUDIO_STEM_SIGNING_KEY_ID: "",
      WORKLOOM_BGM_DISCOVER: "0",
      /** 路径监狱：本地曲库根（正是真机被拦的那类路径）必须放行 */
      WORKLOOM_BGM_ALLOWED_ROOTS: root
    };
    const output = path.join(root, "declared.mp4");
    const result = await mix({
      input: source, output, bgmPath: music, declaredProgramMix: true,
      policy: "keep-dialogue", musicLevelDb: -24, duckingDb: 12,
      fadeInSec: 0.1, fadeOutSec: 0.1, align: false, section: "full",
      env, bins
    });
    assert.ok(fs.existsSync(result.output.path), "声明式直混必须产出成片");
    assert.equal(result.independentAudio.sourceAuthority, "original-program-bytes");
    assert.equal(result.independentAudio.stemsVerified, false);
    assert.equal(result.independentAudio.retainedMusicExcluded, false);
    assert.equal(result.independentAudio.qualityReviewed, false);
    assert.match(String(result.independentAudio.duckingSource ?? ""), /program-mix/);
    /** 不冒充签章：声明路径不得出现 signed/passed 的来源口径 */
    assert.notEqual(result.independentAudio.sourceAuthority, "passed");
  });

  it("不声明、也没有签章：默认按原片节目轨混音，不复评静音或原声", async () => {
    const env = { ...process.env, WORKLOOM_AUDIO_STEM_SIGNING_SECRET: "", WORKLOOM_AUDIO_STEM_SIGNING_KEY_ID: "",
      WORKLOOM_BGM_DISCOVER: "0", WORKLOOM_BGM_ALLOWED_ROOTS: root };
    const result = await mix({ input: source, output: path.join(root, "unsigned.mp4"), bgmPath: music,
      policy: "keep-dialogue", musicLevelDb: -24, duckingDb: 12, fadeInSec: 0.1, fadeOutSec: 0.1,
      align: false, section: "full", env, bins });
    assert.ok(fs.existsSync(result.output.path)); assert.equal(result.independentAudio.sourceAuthority, "original-program-bytes");
    assert.equal(result.independentAudio.stemsVerified, false); assert.equal(result.qualityReviewed, false);
  });
  it("原片无音轨、低规格、静黑画面仍执行实际混音并保留原始字节", async () => {
    const silent = path.join(root, "silent.mp4");
    encode(["-f", "lavfi", "-i", "color=c=black:s=162x90:r=23:d=1.04", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", silent]);
    const original = fs.readFileSync(silent);
    const result = await mix({ input: silent, output: path.join(root, "silent-mixed.mp4"), bgmPath: music,
      policy: "keep-dialogue", align: false, section: "full", bins,
      env: { ...process.env, WORKLOOM_AUDIO_STEM_SIGNING_SECRET: "", WORKLOOM_BGM_ALLOWED_ROOTS: root, WORKLOOM_BGM_DISCOVER: "0" } });
    assert.equal(result.independentAudio.originalSilence, true); assert.equal(result.independentAudio.embeddedAudioUsed, false);
    assert.equal(result.independentAudio.sourceAuthority, "original-program-bytes");
    assert.deepEqual(fs.readFileSync(silent), original); assert.ok(fs.existsSync(result.output.path));
  });
  for (const authority of ["signed-dialogue", "signed-no-dialogue", "original-program"]) {
    it(`${authority}: 0.25 秒配乐铺满 8 秒节目，进程真实结束且没有品质复评`, { timeout: 30000 }, async () => {
      const fixture = path.join(root, authority); fs.mkdirSync(fixture);
      const input = path.join(fixture, "source.mp4"), track = path.join(fixture, "short.wav");
      const output = path.join(fixture, "mixed.mp4");
      encode(["-f", "lavfi", "-i", "color=c=black:s=162x90:r=24:d=8",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=8",
        "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-t", "8", input]);
      encode(["-f", "lavfi", "-i", "sine=frequency=1760:sample_rate=48000:duration=0.25", "-c:a", "pcm_s16le", track]);
      const sourceBytes = fs.readFileSync(input), musicBytes = fs.readFileSync(track);
      const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      const env = { ...process.env, WORKLOOM_BGM_ALLOWED_ROOTS: root, WORKLOOM_BGM_DISCOVER: "0",
        WORKLOOM_AUDIO_STEM_SIGNING_SECRET: randomBytes(32).toString("hex"), WORKLOOM_AUDIO_STEM_SIGNING_KEY_ID: "fixture-only" };
      let audioStems;
      if (authority !== "original-program") {
        const scope = { tenantId: "fixture-t", workspaceId: "fixture-w", projectId: authority, revision: 1 };
        const stems = Object.fromEntries(["dialogue", "ambience", "foley", "music"].map(role => [role,
          { status: "not_applicable", reason: `${role} intentionally absent from synthetic source` }]));
        if (authority === "signed-dialogue") {
          const dialogue = path.join(fixture, "dialogue.wav");
          encode(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=8", "-c:a", "pcm_f32le", dialogue]);
          stems.dialogue = { status: "ready", sourceKind: "tts", path: dialogue, sha256: hash(dialogue) };
        }
        const shot = { shotId: "one", videoSha256: hash(input), durationSec: 8, stems };
        for (const { binding, bindingSha256 } of describeAudioStemSources({ scope, shots: [shot] })) {
          const now = Date.now();
          const receipt = { schemaVersion: "workloom.audio-stem-receipt/v1", purpose: "independent-audio-source", bindingSha256,
            workerId: "synthetic-fixture-worker", jobId: "fixture-job", evidenceSha256: "a".repeat(64),
            issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3600000).toISOString(), keyId: "fixture-only" };
          receipt.signature = createHmac("sha256", env.WORKLOOM_AUDIO_STEM_SIGNING_SECRET).update(audioStemReceiptPayload(receipt)).digest("hex");
          shot.stems[binding.role].receipt = receipt;
        }
        const bundle = await renderAudioStems({ scope, shots: [shot], outDir: path.join(fixture, "stems"), allowedRoots: [root], bins,
          verifySource: createAudioStemReceiptVerifier({ env }) });
        audioStems = { scope, dir: bundle.dir, manifestSha256: bundle.manifestSha256, recipeSha256: bundle.recipeSha256 };
      }
      const started = performance.now();
      const result = await mix({ input, output, bgmPath: track, audioStems, env, bins,
        policy: "keep-dialogue", section: "full", fadeInSec: 0.1, fadeOutSec: 0.1 });
      assert.ok(performance.now() - started < 20000, "real finite-input mix must complete within its fixture timeout");
      assert.equal(result.qualityReviewed, false); assert.equal(result.loudness.after, null); assert.equal(result.levels, null);
      assert.ok(Math.abs(result.output.durationSeconds - 8) < 0.1); assert.equal(result.bgm.looped, true);
      assert.ok(result.bgm.repetitions >= 32); assert.equal(hash(result.bgm.timelinePath), result.bgm.timelineSha256);
      assert.equal(result.output.hash, hash(output)); assert.ok(fs.statSync(output).size > 0);
      assert.deepEqual(fs.readFileSync(input), sourceBytes); assert.deepEqual(fs.readFileSync(track), musicBytes);
      assert.equal(result.independentAudio.sourceAuthority, authority === "original-program" ? "original-program-bytes" : "passed");
      assert.equal(result.independentAudio.embeddedAudioUsed, authority === "original-program");
    });
  }
  it("mix/best显式分轨CLI错误不丢引用：冲突、无值、缺失、null/primitive/array/租户异常真实失败", { timeout: 60000 }, () => {
    const values = [null, false, "reference", 3, [], { scope: { tenantId: "other-tenant", workspaceId: "w", projectId: "p", revision: 1 }, dir: root }];
    const refs = values.map((value, index) => { const file = path.join(root, `invalid-stems-${index}.json`); fs.writeFileSync(file, JSON.stringify(value)); return file; });
    const env = { ...process.env, WORKLOOM_BGM_ALLOWED_ROOTS: root, WORKLOOM_BGM_DISCOVER: "0",
      WORKLOOM_BGM_FFMPEG_PATH: bins.ffmpeg, WORKLOOM_BGM_FFPROBE_PATH: bins.ffprobe,
      WORKLOOM_BGM_LIBRARY_DIR: path.join(root, "empty-library"), WORKLOOM_BGM_BRIDGE_TENANT: "fixture-t", WORKLOOM_AUDIO_STEM_SIGNING_SECRET: "" };
    for (const command of ["mix", "best"]) {
      const cases = [
        ["--audio-stems"], ["--audio-stems", path.join(root, "missing-reference.json")],
        ...refs.map(file => ["--audio-stems", file]),
        ["--declared-program-mix", "--audio-stems", refs[0]],
        ["--declared-program-mix", "--audio-stems", path.join(root, "missing-reference.json")],
      ];
      for (const [index, flags] of cases.entries()) {
        const output = path.join(root, `${command}-invalid-${index}.mp4`);
        const result = spawnSync(process.execPath, [new URL("./cli.mjs", import.meta.url).pathname, command,
          "--in", source, "--out", output, "--bgm", music, ...flags], { env, encoding: "utf8", timeout: 30000 });
        assert.equal(result.error, undefined, "must not fail from timeout"); assert.equal(result.status, 3, result.stdout + result.stderr);
        assert.match(result.stderr, /bad_request|audio_stems_source_unverified|audio_stems_scope_invalid|audio_stems_invalid|tenant_mismatch/);
        assert.equal(fs.existsSync(output), false, "invalid explicit source cannot produce fallback output");
      }
    }
  });
  it("实际工具入口保留显式来源：null/primitive/array/声明冲突失败，旧品质开关不阻塞真实混音", { timeout: 30000 }, async () => {
    const env = { ...process.env, WORKLOOM_BGM_ALLOWED_ROOTS: root, WORKLOOM_BGM_DISCOVER: "0",
      WORKLOOM_BGM_BRIDGE_TENANT: "fixture-t", WORKLOOM_AUDIO_STEM_SIGNING_SECRET: "" };
    for (const tool of ["bgmwrite.mix", "bgmwrite.best"]) {
      for (const [index, authority] of [
        ...[null, false, 3, "reference", []].map(audio_stems => ({ audio_stems })),
        { audio_stems: null, declared_program_mix: true },
        { audio_stems: {}, declared_program_mix: false }, { declared_program_mix: false },
      ].entries()) {
        const output = path.join(root, `${tool}-invalid-tool-${index}.mp4`);
        await assert.rejects(callTool(tool, { input_path: source, output_path: output, bgm_path: music, ...authority }, { env, bins }),
          error => error.code === "bad_request");
        assert.equal(fs.existsSync(output), false);
      }
    }
    const output = path.join(root, "no-quality-gate-tool.mp4");
    const result = await callTool("bgmwrite.mix", { input_path: source, output_path: output, bgm_path: music,
      verify: false, skip_verify: true, align: false, section: "full" }, { env, bins });
    assert.equal(result.receipt.synced, true); assert.equal(result.result.qualityReviewed, false);
    assert.equal(result.result.independentAudio.sourceAuthority, "original-program-bytes");
    assert.ok(fs.existsSync(output)); assert.equal(result.result.levels, null);
  });
  after(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });
});
