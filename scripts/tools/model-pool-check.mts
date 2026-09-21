#!/usr/bin/env node
/**
 * model-pool-check · 真实模型池探活与配置检查（B-26）
 *
 * 用法：tsx --env-file=.env scripts/tools/model-pool-check.mts [--strict]
 * mock 模式输出全池（9 模型）；真实模式按 vendor baseURL 装配并报告缺位；
 * --strict 在真实模式下要求 9/9 全配置。
 */
import { MODEL_CATALOG, poolFromEnv } from "@workloom/base/model-router";

const provider = (process.env.LLM_PROVIDER ?? "mock").trim() || "mock";
const pool = poolFromEnv();
console.log(`模型池：LLM_PROVIDER=${provider} · ${pool.size}/${MODEL_CATALOG.length}`);
const vendors = [...new Set(MODEL_CATALOG.map((m) => m.vendor))];
for (const vendor of vendors) {
  const models = MODEL_CATALOG.filter((m) => m.vendor === vendor);
  const envKey = models[0]!.baseUrlEnv;
  const configured = provider === "mock" || Boolean(process.env[envKey]?.trim() || process.env.LLM_BASE_URL?.trim());
  const missingModels = models.filter((m) => !pool.has(m.id)).map((m) => m.id);
  console.log(`${configured ? "✓" : "○"} ${vendor.padEnd(10)} ${envKey} · 池内 ${models.length - missingModels.length}/${models.length}${missingModels.length ? `（缺：${missingModels.join(",")}）` : ""}`);
}
if (provider !== "mock" && pool.size < MODEL_CATALOG.length) {
  console.log("\n提示：缺位模型不阻断 mock 验货；真实三档降级链需要至少每档 2 家可用。");
}
if (process.argv.includes("--strict") && provider !== "mock" && pool.size < MODEL_CATALOG.length) process.exit(1);
