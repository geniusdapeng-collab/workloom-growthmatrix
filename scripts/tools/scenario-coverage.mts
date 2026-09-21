#!/usr/bin/env node
/**
 * scenario-coverage · 跨包场景覆盖审计（B-60）
 *
 * 用法：tsx scripts/tools/scenario-coverage.mts [--strict]
 * 合并 geo-growth / hotel / ai-video 三包 model-policy.yml 场景，输出「场景 × 包 × 套餐 × 档位」矩阵，
 * 落 docs/reports/scenario-coverage.md；--strict 存在缺口时非 0。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildScenarioCoverage, loadModelPolicy, scenarioCoverageMarkdown, type PackagePolicy } from "@workloom/base/model-router";

const bundles = ["geo-growth", "hotel", "ai-video"];
const packages: PackagePolicy[] = bundles.map((id) => {
  const loaded = loadModelPolicy(join(process.cwd(), "bundles", id));
  if (!loaded.policy) throw new Error(`${id} 模型策略装载失败：${loaded.issues.join("；")}`);
  return { packageId: id, policy: loaded.policy, issues: loaded.issues };
});
const result = buildScenarioCoverage(packages);
const markdown = scenarioCoverageMarkdown(result);
mkdirSync(join(process.cwd(), "docs", "reports"), { recursive: true });
writeFileSync(join(process.cwd(), "docs", "reports", "scenario-coverage.md"), markdown, "utf8");
console.log(`场景覆盖：并集 ${result.scenes.length} 场景 × ${packages.length} 包 = ${result.rows.length} 行；缺口 ${result.gaps.length} 项`);
for (const gap of result.gaps.slice(0, 20)) console.log(`  ✗ [${gap.packageId}] ${gap.scene}：${gap.reason}`);
console.log("报告：docs/reports/scenario-coverage.md");
if (process.argv.includes("--strict") && result.gaps.length > 0) process.exit(1);
