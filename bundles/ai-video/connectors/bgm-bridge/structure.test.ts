/**
 * 结构识别 + 自动选段的**真机**验证（真实 ffmpeg 造素材；没装 ffmpeg 的环境自动跳过）。
 *
 * 为什么单独一组：这两件事只有"真听真算"才能验证——
 *  · 曲目结构：人造一条 安静→高潮→安静 的曲子，看分段是否把高潮找出来；
 *  · 片子高潮：人造一条"前段安静、后段三连切+更响"的片子，看是否按剪辑密度定高潮（而不是按台词音量）；
 *  · 选段落点：把曲子高潮段的峰值对到片子高潮时刻，误差要在 1.5s 内，并且回执里要有依据。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { analyzeStructure, callTool, filmClimaxTime, filmEnergyArc, mix } from "./core.mjs";
import { detectCuts, detectVoiceBandSegments, resolveBinaries, probeMedia } from "./measure.mjs";
import { describeAudioStemSources, renderAudioStems } from "./audio-stems.mjs";
import { audioStemReceiptPayload, createAudioStemReceiptVerifier } from "./audio-stems-trust.mjs";

const bins = resolveBinaries();
const hasFfmpeg = (() => {
  try {
    execFileSync(bins.ffmpeg, ["-hide_banner", "-version"], { stdio: "ignore" });
    execFileSync(bins.ffprobe, ["-hide_banner", "-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const workDir = join(realpathSync(tmpdir()), `bgm-structure-${Date.now().toString(36)}`);
const musicPath = join(workDir, "music.wav");

/**
 * 「混音 − 原片」在指定窗口的残差 RMS（dBFS）——用来量"配乐到底有没有进画面"。
 * 这是 2026-09-24 真机事故（配乐被整条延后、前 25.7s 静音）的**结果级判据**。
 */
function measureResidualRmsDb(reference: string, mixed: string, startSec: number, durationSec: number): number {
  const decode = (file: string): Float32Array => {
    const buf = execFileSync(bins.ffmpeg, [
      "-v", "error", "-ss", String(startSec), "-t", String(durationSec), "-i", file,
      "-f", "f32le", "-ac", "1", "-ar", "48000", "-",
    ], { maxBuffer: 1 << 30 });
    const n = Math.floor(buf.length / 4);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i += 1) out[i] = buf.readFloatLE(i * 4);
    return out;
  };
  const a = decode(reference);
  const b = decode(mixed);
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i += 1) { const d = b[i]! - a[i]!; sum += d * d; }
  const rms = Math.sqrt(sum / Math.max(1, n));
  return rms > 0 ? 20 * Math.log10(rms) : -120;
}
function decodedAudio(file: string): Buffer {
  return execFileSync(bins.ffmpeg, ["-v", "error", "-i", file, "-vn", "-f", "s16le", "-ac", "2", "-ar", "48000", "-"], { maxBuffer: 1 << 26 });
}
function videoPacketHash(file: string): string {
  return execFileSync(bins.ffmpeg, ["-v", "error", "-i", file, "-map", "0:v:0", "-c:v", "copy", "-f", "hash", "-"], { encoding: "utf8" }).trim();
}
const filmPath = join(workDir, "film.mp4");
const mixedPath = join(workDir, "film-scored.mp4");
const scope = { tenantId: "fixture-t", workspaceId: "fixture-w", projectId: "structure", revision: 1 };
const env = { ...process.env, WORKLOOM_AUDIO_STEM_SIGNING_SECRET: randomBytes(32).toString("hex"), WORKLOOM_AUDIO_STEM_SIGNING_KEY_ID: "synthetic-test-only" };
let audioStems: object;
const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

function buildStructuredMusic() {
  // 26s：0–8 安静铺底 / 8–20 高潮（带 2Hz 脉冲 = 120BPM）/ 20–26 安静收尾
  execFileSync(bins.ffmpeg, [
    "-hide_banner", "-v", "error", "-y",
    "-f", "lavfi", "-i", "aevalsrc=0.18*sin(2*PI*220*t)+0.10*sin(2*PI*330*t):d=26:s=44100",
    "-f", "lavfi", "-i", "aevalsrc=0.5*exp(-mod(t\\,0.5)*9)*sin(2*PI*90*t):d=26:s=44100",
    "-filter_complex",
    "[0:a]volume='if(between(t,8,20),1.0,0.28)':eval=frame[pad];"
    + "[1:a]volume='if(between(t,8,20),1.0,0.0)':eval=frame[beat];"
    + "[pad][beat]amix=inputs=2:duration=longest:normalize=0[mix];"
    + "[mix]loudnorm=I=-16:TP=-2:LRA=8[aout]",
    "-map", "[aout]", "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", musicPath,
  ]);
}

function buildFilmWithClimax() {
  // 30s 画面：0–18 单镜（暗）/ 18–21 三连切 / 21–30 单镜（亮）
  execFileSync(bins.ffmpeg, [
    "-hide_banner", "-v", "error", "-y",
    "-f", "lavfi", "-i", "color=c=0x1b2b4d:size=320x180:rate=15:duration=18",
    "-f", "lavfi", "-i", "color=c=0xe8dcc8:size=320x180:rate=15:duration=1",
    "-f", "lavfi", "-i", "color=c=0x15525a:size=320x180:rate=15:duration=1",
    "-f", "lavfi", "-i", "color=c=0xd9762a:size=320x180:rate=15:duration=1",
    "-f", "lavfi", "-i", "color=c=0x0f3b2e:size=320x180:rate=15:duration=9",
    "-filter_complex",
    "[0:v][1:v][2:v][3:v][4:v]concat=n=5:v=1:a=0[vout]",
    "-map", "[vout]", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "26", "-pix_fmt", "yuv420p", join(workDir, "video-only.mp4"),
  ]);
  // 音轨：全程环境声；18–24s 明显更响（对应"画面高潮段"）
  execFileSync(bins.ffmpeg, [
    "-hide_banner", "-v", "error", "-y",
    "-f", "lavfi", "-i", "anoisesrc=duration=30:color=pink:amplitude=0.3:seed=17",
    "-af", "lowpass=f=4500,volume='if(between(t,18,24),1.0,0.10)':eval=frame,loudnorm=I=-20:TP=-2:LRA=8",
    "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", join(workDir, "film-audio.wav"),
  ]);
  execFileSync(bins.ffmpeg, [
    "-hide_banner", "-v", "error", "-y",
    "-i", join(workDir, "video-only.mp4"), "-i", join(workDir, "film-audio.wav"),
    "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart", "-shortest", filmPath,
  ]);
}

describe.skipIf(!hasFfmpeg)("配乐结构识别与选段（真实 ffmpeg）", () => {
  beforeAll(async () => {
    mkdirSync(workDir, { recursive: true });
    buildStructuredMusic();
    buildFilmWithClimax();
    const stems: Record<string, any> = { ambience: { status: "ready", path: join(workDir, "film-audio.wav"), sha256: hash(join(workDir, "film-audio.wav")), sourceKind: "synthesized_ambience" },
      ...Object.fromEntries(["dialogue", "foley", "music"].map((role) => [role, { status: "not_applicable", reason: "Independently generated synthetic ambience-only fixture" }])) };
    const shot = { shotId: "film", videoSha256: hash(filmPath), durationSec: 30, stems };
    for (const { binding, bindingSha256 } of describeAudioStemSources({ scope, shots: [shot] })) {
      const now = Date.now();
      const receipt: Record<string, string> = { schemaVersion: "workloom.audio-stem-receipt/v1", purpose: "independent-audio-source", bindingSha256,
        workerId: "synthetic-worker", jobId: "structure-fixture", evidenceSha256: "a".repeat(64), issuedAt: new Date(now - 1000).toISOString(),
        expiresAt: new Date(now + 3600000).toISOString(), keyId: "synthetic-test-only" };
      receipt.signature = createHmac("sha256", env.WORKLOOM_AUDIO_STEM_SIGNING_SECRET).update(audioStemReceiptPayload(receipt)).digest("hex");
      stems[binding.role].receipt = receipt;
    }
    const bundle = await renderAudioStems({ scope, shots: [shot], outDir: join(workDir, "independent-stems"),
      allowedRoots: [realpathSync(workDir)], bins, verifySource: createAudioStemReceiptVerifier({ env }) });
    audioStems = { dir: bundle.dir, manifestSha256: bundle.manifestSha256, recipeSha256: bundle.recipeSha256, scope };
  }, 180_000);

  afterAll(() => {
    if (!process.env.BGM_KEEP_FIXTURES) rmSync(workDir, { recursive: true, force: true });
  });

  it("曲目结构：8–20s 的高潮段被识别为 drop，拍速落在 120BPM 附近", async () => {
    const structure = await analyzeStructure({ input: musicPath });
    const drop = structure.structure.segments.find((segment) => segment.type === "drop");
    expect(drop, `分段结果：${JSON.stringify(structure.structure.segments)}`).toBeTruthy();
    expect(drop!.startSec).toBeGreaterThanOrEqual(7);
    expect(drop!.startSec).toBeLessThanOrEqual(10);
    expect(drop!.endSec).toBeGreaterThanOrEqual(19);
    expect(drop!.endSec).toBeLessThanOrEqual(21.5);
    expect(structure.climax.candidates[0]!.type).toBe("drop");
    // 2Hz 脉冲 → 120BPM（允许倍频候选 60/240）
    expect(structure.tempo.bpm).not.toBeNull();
    expect([60, 120, 240]).toContain(structure.tempo.bpm);
    expect(structure.tempo.confidence).not.toBe("low");
  }, 30_000);

  it("片子高潮：三连切处被识别为 cut-density 高潮（不是音量峰值）", async () => {
    const probe = await probeMedia(filmPath, { bins });
    const arc = await filmEnergyArc({ input: filmPath });
    const cuts = (await detectCuts({ input: filmPath })).cuts;
    const voice = await detectVoiceBandSegments({ input: filmPath, duration: probe.duration });
    const climax = filmClimaxTime({ arc, cuts, voice, durationSec: probe.duration });
    expect(cuts.length).toBeGreaterThanOrEqual(3);
    expect(climax.basis).toBe("cut-density");
    expect(climax.timeSec).toBeGreaterThanOrEqual(17.5);
    expect(climax.timeSec).toBeLessThanOrEqual(21.5);
  }, 30_000);

  it("按声明的高潮落点选段出片，保持开头配乐且不分析源片品质", async () => {
    const original = hash(filmPath);
    const logPath = join(workDir, "requested-mix-calls.jsonl");
    const guardPath = join(workDir, "requested-mix-ffmpeg.mjs");
    writeFileSync(logPath, "");
    writeFileSync(guardPath, `#!${process.execPath}\nimport fs from 'node:fs';import {spawnSync} from 'node:child_process';\n`
      + `const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(logPath)},JSON.stringify(args)+'\\n');\n`
      + `const inputs=args.flatMap((a,i)=>a==='-i'?[args[i+1]]:[]);\n`
      + `if(args.includes('null')&&inputs.some(p=>p.endsWith('.mp4'))){process.stderr.write('test-only: source-quality-review-forbidden');process.exit(73);}\n`
      + `const r=spawnSync(${JSON.stringify(bins.ffmpeg)},args,{stdio:'inherit'});process.exit(r.status??74);\n`, { mode: 0o700 });
    const report = await mix({
      input: filmPath,
      output: mixedPath,
      bgmPath: musicPath,
      audioStems, env,
      policy: "keep-all",
      musicLevelDb: -10,
      duckingDb: 10,
      section: "auto",
      filmPeakAt: 20,
      evidenceDir: workDir,
      bins: { ...bins, ffmpeg: guardPath },
    });
    expect(existsSync(mixedPath)).toBe(true);
    expect(report.section.mode).toBe("auto");
    expect(report.section.chosen!.type).toBe("drop");
    expect(report.section.filmPeakAlign).toBeTruthy();
    expect(report.section.played).toBeTruthy();
    expect(report.section.filmPeakAlign.basis).toBe("declared");
    expect(report.section.filmPeakAlign.filmPeakSec).toBe(20);
    expect(report.section.played.sha256).toBe(hash(report.section.played.path));
    expect(hash(filmPath)).toBe(original);
    expect(report.qualityReviewed).toBe(false);
    expect(report.loudness.before).toBeNull();
    expect(report.loudness.after).toBeNull();

    /**
     * 落点校验（2026-09-24 语义更新）：
     * 旧实现是"整条音乐床延后"（placedAtSec + anchor ≈ 片子高点），代价是**前段完全静音**
     * （真机事故：30s 成片里 25.7s 无音乐）。
     * 新实现是**相位预卷**：`mode=preroll-loop`，峰值的**实际落点**（含整圈循环）对齐片子高点，
     * 且从 0s 起全程有音乐。断言改用 `peakLandedAtSec`。
     */
    const align = report.section.filmPeakAlign as {
      filmPeakSec: number; musicAnchorOffsetSec: number; placedAtSec: number;
      peakLandedAtSec?: number; mode?: string;
    };
    expect(align.mode).toBe("preroll-loop");
    expect(typeof align.peakLandedAtSec).toBe("number");
    expect(Math.abs((align.peakLandedAtSec ?? 0) - align.filmPeakSec)).toBeLessThanOrEqual(1.5);
    /**
     * 回归（结果级，最关键）：**开头不许静音**。
     * 旧实现把整条床延后 25.7s，前段残差 ≈ 0；新实现从 0s 起有音乐，
     * 因此用"混音 − 原片"的前 3s 残差 RMS 作为判据（> -40dBFS 即证明开头有配乐）。
     */
    const earlyMusic = measureResidualRmsDb(filmPath, mixedPath, 0, 3);
    expect(earlyMusic).toBeGreaterThan(-40);
    const preroll = report.section.preroll as { applied?: boolean; phaseSec?: number } | undefined;
    if (preroll?.applied) {
      expect(preroll.phaseSec!).toBeGreaterThanOrEqual(0);
      expect(preroll.phaseSec!).toBeLessThan(align.filmPeakSec);
    }
    expect(Object.values(report.checks).every(Boolean)).toBe(true);
    expect(report.output.hash).toBe(hash(mixedPath));
    expect(videoPacketHash(mixedPath)).toBe(videoPacketHash(filmPath));
    const selected = decodedAudio(report.section.played.path);
    const rotated = decodedAudio(report.section.preroll.path);
    const splitByte = Math.round(report.section.preroll.phaseSec * 48000) * 4;
    const expectedRotation = Buffer.concat([selected.subarray(splitByte), selected.subarray(0, splitByte)]);
    expect(rotated.equals(expectedRotation)).toBe(true);
    expect(report.section.preroll.sha256).toBe(hash(report.section.preroll.path));
    const calls = readFileSync(logPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(calls.some(args => args.includes("null") && args.some(arg => String(arg).endsWith(".mp4")))).toBe(false);
  }, 180_000);

  it("未声明落点不推断源片，默认原节目混音可成功，非法落点不产生成功产物", async () => {
    const options = { input: filmPath, bgmPath: musicPath, env, bins, section: "full", policy: "keep-all" };
    const output = join(workDir, "default-original-program.mp4");
    const report = await mix({ ...options, output });
    expect(report.section.filmPeakAlign.skipped).toBe(true);
    expect(report.section.filmPeakAlign.basis).toBe("not_requested");
    expect(report.qualityReviewed).toBe(false);
    expect(report.independentAudio.stemsVerified).toBe(false);
    expect(report.independentAudio.sourceAuthority).toBe("original-program-bytes");
    expect(report.output.hash).toBe(hash(output));
    for (const [index, filmPeakAt] of [-1, NaN, Infinity, "20", 30, 31].entries()) {
      const invalidOutput = join(workDir, `invalid-peak-${index}.mp4`);
      await expect(mix({ ...options, output: invalidOutput, filmPeakAt })).rejects.toMatchObject({ code: "bad_request" });
      expect(existsSync(invalidOutput)).toBe(false);
    }
  }, 180_000);

  it("CLI 与工具入口执行声明落点；空值、布尔值、非数字与越界请求明确报错", async () => {
    const parameters = { input_path: filmPath, bgm_path: musicPath, section: "auto", policy: "keep-all" };
    const output = join(workDir, "tool-declared-peak.mp4");
    const tool = await callTool("bgmwrite.mix", { ...parameters, output_path: output, film_peak_at_sec: "0" }, { bins, env });
    expect(tool.receipt.synced).toBe(true);
    expect(tool.receipt.sha256).toBe(hash(output));
    expect(tool.result.section.filmPeakAlign.filmPeakSec).toBe(0);
    expect(tool.result.section.filmPeakAlign.peakLandedAtSec).toBeCloseTo(0, 3);
    expect(tool.result.qualityReviewed).toBe(false);
    for (const [index, film_peak_at_sec] of ["", " ", true, [], "oops", -1, Infinity, 30].entries()) {
      const invalid = join(workDir, `invalid-tool-cue-${index}.mp4`);
      await expect(callTool("bgmwrite.mix", { ...parameters, output_path: invalid, film_peak_at_sec }, { bins, env }))
        .rejects.toMatchObject({ code: "bad_request" });
      expect(existsSync(invalid)).toBe(false);
    }
    const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
    const invoke = (out: string, cue: string[]) => spawnSync(process.execPath, [cli, "mix", "--in", filmPath, "--out", out,
      "--bgm", musicPath, "--section", "auto", "--policy", "keep-all", "--film-peak-at", ...cue],
    { encoding: "utf8", env, timeout: 60000 });
    const cliOutput = join(workDir, "cli-declared-peak.mp4");
    const success = invoke(cliOutput, ["20"]);
    expect(success.status, success.stderr).toBe(0);
    expect(success.stdout).toContain("按声明落点 20s");
    expect(existsSync(cliOutput)).toBe(true);
    expect(videoPacketHash(cliOutput)).toBe(videoPacketHash(filmPath));
    for (const [index, cue] of [[], [""], ["NaN"], ["Infinity"], ["-1"], ["30"]].entries()) {
      const invalid = join(workDir, `invalid-cli-cue-${index}.mp4`);
      const result = invoke(invalid, cue);
      expect(result.status).toBe(3);
      expect(result.stderr).toContain("bad_request");
      expect(existsSync(invalid)).toBe(false);
    }
  }, 180_000);
});
