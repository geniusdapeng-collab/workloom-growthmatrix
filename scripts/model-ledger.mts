#!/usr/bin/env node
/**
 * model-ledger · 模型配置版本台账（B-30）
 *
 * 用法：
 *   tsx scripts/model-ledger.mts --report [--workspace ws-geo]   # 当前池 + 最近变更 + 回滚命令
 *   tsx scripts/model-ledger.mts --record <changes.json> --by MEM-001 [--reason "…"] [--workspace ws-geo]
 *
 * changes.json: { "prev": ModelConfigSnapshot[], "next": ModelConfigSnapshot[] }
 */
import { readFileSync } from "node:fs";
import { MODEL_CATALOG, poolFromEnv, summarizeModelLedger } from "@workloom/base/model-router";
import { listModelConfigChanges, recordModelConfigChange } from "../apps/server/src/service/model-ledger.js";

const args = process.argv.slice(2);
const argOf = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const workspaceId = argOf("--workspace") ?? "ws-geo";

if (args.includes("--report")) {
  const pool = poolFromEnv();
  const vendorEnv = new Map(MODEL_CATALOG.map((m) => [m.vendor, m.baseUrlEnv]));
  console.log(`模型池（LLM_PROVIDER=${process.env.LLM_PROVIDER ?? "mock"}）：${pool.size}/${MODEL_CATALOG.length} 个模型`);
  for (const [vendor, envKey] of vendorEnv) {
    const configured = Boolean(process.env[envKey]?.trim() || process.env.LLM_BASE_URL?.trim());
    console.log(`${configured ? "✓" : "○"} ${vendor.padEnd(10)} ${envKey}${configured ? "" : "（未配置，链内跳过）"}`);
  }
  try {
    const rows = await listModelConfigChanges(workspaceId, 10);
    console.log(`\n${summarizeModelLedger(rows.map((r) => ({ at: r.at, by: r.by, changes: r.changes, ...(r.reason ? { reason: r.reason } : {}) })))}`);
  } catch (error) {
    console.log(`\n（事件库暂不可读：${error instanceof Error ? error.message : String(error)}）`);
  }
} else if (args.includes("--record")) {
  const file = argOf("--record");
  const by = argOf("--by");
  if (!file || !by) {
    console.error("用法：--record <changes.json> --by MEM-001");
    process.exit(1);
  }
  const body = JSON.parse(readFileSync(file, "utf8")) as { prev: never[]; next: never[] };
  const result = await recordModelConfigChange(workspaceId, {
    by, prev: body.prev, next: body.next, reason: argOf("--reason"),
  });
  console.log(JSON.stringify({ eventId: result.eventId, changes: result.changes, rollback: result.changes.map((c) => `tsx scripts/model-ledger.mts --set ${c.scene}=${c.from}`) }, null, 1));
} else {
  console.error("用法：--report | --record <changes.json> --by MEM-001");
  process.exit(1);
}
