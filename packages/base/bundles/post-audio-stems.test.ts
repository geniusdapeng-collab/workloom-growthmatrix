/** Run native cryptographic/media contracts in the normal base CI test command. */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const bins = [process.env.WORKLOOM_POST_FFMPEG_PATH || "ffmpeg", process.env.WORKLOOM_POST_FFPROBE_PATH || "ffprobe"];
const hasMediaTools = bins.every((bin) => spawnSync(bin, ["-version"], { stdio: "ignore" }).status === 0);
/**
 * U-02：媒体用例需要**完整构建**（libx264 编码 testsrc2 夹具）。
 * 此前只看「二进制在不在」——PATH 里的精简构建（无 libx264）会让 26+9 个原生用例
 * 以 audio_stems_stale / encoder 错误的形式失败，看不出是环境问题。
 * 这里把能力探针前置：缺工具=跳过（沿用仓库惯例）；缺 libx264=显式告警并在下面点名。
 */
const ffmpegEncoders = hasMediaTools
  ? spawnSync(bins[0], ["-hide_banner", "-encoders"], { encoding: "utf8", maxBuffer: 4 << 20 })
  : null;
const hasLibx264 = Boolean(ffmpegEncoders && /\blibx264\b/.test(ffmpegEncoders.stdout ?? ""));
const mediaCapable = hasMediaTools && hasLibx264;
it("媒体工具链能力探针（U-02）：ffmpeg/ffprobe 与 libx264 如实回报，不把环境缺陷伪装成 audio_stems_stale", () => {
  console.log(`[media-toolchain] ffmpeg=${bins[0]} present=${hasMediaTools} libx264=${hasLibx264} → mediaCapable=${mediaCapable}`);
  if (!mediaCapable) {
    console.log("[media-toolchain] ⚠️ 原生媒体用例将跳过；本机安装完整 ffmpeg 或设 WORKLOOM_POST_FFMPEG_PATH 指向含 libx264 的构建（node scripts/ci/media-toolchain.mjs 可打指纹）");
  }
  // 探针只回报不判红：缺工具/缺能力时用例跳过（仓库既有惯例），但环境状态必须在测试输出里可见。
  // 不变式：capable 必然蕴含工具在位且具备 libx264（防止日后把判定改坏）。
  expect(mediaCapable ? hasMediaTools && hasLibx264 : true).toBe(true);
});
function native(files: string[]) {
  const run = spawnSync(process.execPath, ["--test", ...files.map((file) => resolve(root, file))], {
    cwd: root, env: process.env, encoding: "utf8", timeout: 180000, maxBuffer: 8 << 20,
  });
  expect(run.error, run.error?.message).toBeUndefined();
  expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect(run.stdout).toMatch(/(?:#|ℹ) fail 0/);
  expect(run.stdout).toMatch(/(?:#|ℹ) skipped 0/);
}
it("validates real receipt signatures, binding mutations, host tenant and expiry without media tools", () => {
  native(["bundles/ai-video/connectors/post-bridge/audio-stems-trust.test.mjs"]);
}, 30000);
it.skipIf(!mediaCapable)("renders and replays independent stems; exercises the real mixer, CLI and HTTP idempotency", () => {
  native(["bundles/ai-video/connectors/post-bridge/audio-stems.test.mjs", "bundles/ai-video/connectors/bgm-bridge/audio-stems-mix.test.mjs"]);
}, 180000);
