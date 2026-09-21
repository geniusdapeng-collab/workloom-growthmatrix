#!/usr/bin/env node
/**
 * channel-readiness · 通道就绪与声明排除（B-75）
 *
 * 用法：tsx scripts/channel-readiness.mts [--strict]
 *  - 默认只报告（exit 0）；
 *  - --strict：存在 declared_exclusion 时非 0（用于「本轮要求全通道联调」的发布前检查）。
 */
import { channelReadiness, declaredExclusions } from "@workloom/base/publish-rpa";

const strict = process.argv.includes("--strict");
const rows = channelReadiness();
const label = { ready: "✓ ready", needs_live_session: "○ 待真机会话联调", declared_exclusion: "✗ 声明排除" } as const;
console.log("通道就绪矩阵（B-75）：");
for (const row of rows) {
  console.log(`${label[row.state].padEnd(18)} ${row.id.padEnd(12)} ${row.label} —— ${row.detail}`);
}
const exclusions = rows.filter((row) => row.state === "declared_exclusion");
console.log(`\n声明排除 ${exclusions.length} 项：${exclusions.map((r) => r.id).join("、") || "无"}`);
console.log("豁免单与触发条件见 docs/channel-exclusions.md（未联调通道 fail-closed，不伪造回执）。");
if (strict && exclusions.length > 0) process.exit(1);
