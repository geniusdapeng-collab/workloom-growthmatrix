/**
 * 媒体工具链指纹探针（U-02）
 *
 * 背景：audio-stems 的冻结缓存复验要求「同一 ffmpeg/ffprobe 构建 + 同一渲染器」，
 * 历史上环境里存在两套构建（PATH 里的精简构建 / kit 里的完整构建）时，
 * 复验只会给出笼统的 `audio_stems_stale`，无法区分环境漂移与篡改。
 *
 * 本探针把「这台机器/这条流水线到底用哪对二进制」打成一行可归档的指纹，
 * 供 CI 日志、验收证据与问题复现引用：
 *   - ffmpeg / ffprobe 版本首行 + 可执行文件 sha256（存在时）
 *   - libx264 能力（audio-stems 媒体用例的硬前置）
 *   - 渲染器摘要（bundles/ai-video/connectors/bgm-bridge/audio-stems.mjs）
 *
 * 用法：
 *   node scripts/ci/media-toolchain.mjs            # 打印指纹；工具缺失/缺 libx264 只告警（退出码 0）
 *   node scripts/ci/media-toolchain.mjs --strict   # 作为门禁：缺工具或缺 libx264 退出码 1
 *   node scripts/ci/media-toolchain.mjs --json     # 机器可读输出（CI 归档用）
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const strict = process.argv.includes("--strict");
const asJson = process.argv.includes("--json");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const renderer = path.join(root, "bundles/ai-video/connectors/bgm-bridge/audio-stems.mjs");

const bins = {
  ffmpeg: process.env.WORKLOOM_POST_FFMPEG_PATH || process.env.WORKLOOM_SUBTITLE_FFMPEG_PATH || "ffmpeg",
  ffprobe: process.env.WORKLOOM_POST_FFPROBE_PATH || process.env.WORKLOOM_SUBTITLE_FFPROBE_PATH || "ffprobe",
};

function run(bin, args) {
  try {
    return { ok: true, out: execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20000 }) };
  } catch (err) {
    return { ok: false, out: "", error: err instanceof Error ? err.message : String(err) };
  }
}

function sha256(file) {
  try { return createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
  catch { return null; }
}

function probe(bin) {
  const version = run(bin, ["-version"]);
  if (!version.ok) return { bin, present: false, error: version.error };
  const firstLine = (version.out.split("\n")[0] ?? "").trim();
  const resolved = run("which", [bin]).ok ? run("which", [bin]).out.trim() : bin;
  return { bin: resolved, present: true, version: firstLine, sha256: sha256(resolved) };
}

const report = {
  schemaVersion: "workloom.media-toolchain/v1",
  node: process.version,
  platform: process.platform,
  ffmpeg: probe(bins.ffmpeg),
  ffprobe: probe(bins.ffprobe),
  libx264: false,
  renderer: { path: path.relative(root, renderer), sha256: sha256(renderer) },
};
if (report.ffmpeg.present) {
  const encoders = run(report.ffmpeg.bin, ["-hide_banner", "-encoders"]);
  report.libx264 = encoders.ok && /\blibx264\b/.test(encoders.out);
}
const capable = report.ffmpeg.present && report.ffprobe.present && report.libx264;

if (asJson) {
  console.log(JSON.stringify({ ...report, capable }, null, 2));
} else {
  console.log(`[media-toolchain] node=${report.node} ${report.platform}`);
  console.log(`[media-toolchain] ffmpeg=${report.ffmpeg.present ? `${report.ffmpeg.bin} sha256=${String(report.ffmpeg.sha256).slice(0, 16)}…` : "缺失"} ${report.ffmpeg.version ?? ""}`);
  console.log(`[media-toolchain] ffprobe=${report.ffprobe.present ? `${report.ffprobe.bin} sha256=${String(report.ffprobe.sha256).slice(0, 16)}…` : "缺失"} ${report.ffprobe.version ?? ""}`);
  console.log(`[media-toolchain] libx264=${report.libx264 ? "yes" : "no"}`);
  console.log(`[media-toolchain] renderer=${report.renderer.path} sha256=${String(report.renderer.sha256).slice(0, 16)}…`);
  if (!capable) {
    console.log("[media-toolchain] ⚠️ 不满足 audio-stems 媒体用例前置（需 ffmpeg/ffprobe + libx264）：");
    console.log("  - 本机：安装完整 ffmpeg（含 libx264），或设置 WORKLOOM_POST_FFMPEG_PATH / WORKLOOM_SUBTITLE_FFMPEG_PATH 指向完整构建；");
    console.log("  - CI：db-gate 会 apt-get 安装发行版 ffmpeg（bookworm 构建自带 libx264）；构建漂移会让冻结音轨缓存复验报 audio_stems_stale（U-02）。");
    console.log("  - 相关用例：bundles/ai-video/connectors/post-bridge/audio-stems.test.mjs、bundles/ai-video/connectors/bgm-bridge/audio-stems-mix.test.mjs");
    console.log("  - 说明文档：docs/MEDIA-TOOLCHAIN.md");
  }
}

if (strict && !capable) process.exit(1);
