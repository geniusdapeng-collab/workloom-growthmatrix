#!/usr/bin/env node
/**
 * watchdog · 三类巡检 CLI（B-35）
 *
 * 用法：tsx --env-file=.env scripts/tools/watchdog.mts [--workspace ws-geo] [--strict]
 * 默认只报告；--strict 在存在 critical 时退出码 1（供演练/门禁引用）。
 */
import { runWatchdog } from "../../apps/server/src/service/watchdog.js";

const args = process.argv.slice(2);
const argOf = (name: string, fallback: string): string => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const workspaceId = argOf("--workspace", "ws-geo");
const report = await runWatchdog(workspaceId);
console.log(report.summary);
console.log(`\n计数：触发器 ${report.counts.trigger} · 连接器 ${report.counts.connector} · 审批 ${report.counts.approval} · 严重 ${report.counts.critical} · 警告 ${report.counts.warn}`);
console.log(`事件凭证：${report.eventId}`);
if (args.includes("--strict") && report.counts.critical > 0) process.exit(1);
