#!/usr/bin/env node
/**
 * gen-config-check · 生图/生视频配置检查（B-27）
 *
 * 用法：tsx --env-file=.env scripts/tools/gen-config-check.mts [--strict]
 * 检查 VOLCENGINE_ARK_API_KEY / SEEDANCE_ENDPOINT / SEEDREAM_ENDPOINT；
 * 缺项时明确输出「未配置，生成工具将返回 connector-required」；--strict 缺项即非 0。
 */
const KEYS: Array<[string, string, string]> = [
  ["VOLCENGINE_ARK_API_KEY", "方舟 API Key", "生图/生视频鉴权（只放环境/秘密存储）"],
  ["SEEDANCE_ENDPOINT", "Seedance 视频模型 ID", "视频渲染提交使用（如 doubao-seedance-2-5-260628）"],
  ["SEEDREAM_ENDPOINT", "Seedream 图像模型 ID", "AI 生图使用（如 doubao-seedream-4-0-250828）"],
];
let missing = 0;
console.log("生图/生视频配置（B-27）：");
for (const [key, label, note] of KEYS) {
  const value = process.env[key]?.trim() ?? "";
  if (!value) missing += 1;
  console.log(`${value ? "✓" : "○"} ${key.padEnd(28)} ${label} —— ${value ? "已配置" : `未配置：${note}`}`);
}
console.log(missing === 0
  ? "\n配置齐备：生图/生视频工具可提交真实请求（回执以平台返回为准）。"
  : `\n缺 ${missing} 项：相关工具将 fail-closed（connector-required / mock 标注），不伪造回执。`);
if (process.argv.includes("--strict") && missing > 0) process.exit(1);
