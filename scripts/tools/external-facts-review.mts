#!/usr/bin/env node
/**
 * external-facts-review · 外部事实季度复核（B-84）
 *
 * 用法：tsx scripts/tools/external-facts-review.mts [--strict]
 * 读取平台规格注册表（reviewDue/verifiedAt/status），列出逾期与待复核条目，
 * 落 `docs/reports/external-facts-review.md`；--strict 在存在逾期时非 0。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPlatformSpecs, specsDueForReview } from "@workloom/base/publish-rpa";

const specsPath = join(process.cwd(), "bundles", "geo-growth", "templates", "platform-specs.json");
const specs = loadPlatformSpecs(specsPath);
const due = specsDueForReview(specs);
const lines = [
  "# 外部事实季度复核清单（B-84）",
  "",
  `> 生成时间：${new Date().toISOString()}｜规格总数：${specs.platforms.length}｜待复核：${due.length}`,
  "> 事实源：`bundles/geo-growth/templates/platform-specs.json`（reviewDue / verifiedAt / status）。",
  "",
  "| 平台 | 状态 | 最近核验 | 复核到期 | 逾期天数 | 原因 |",
  "|---|---|---|---|---:|---|",
  ...due.map((d) => `| ${d.label}（${d.id}） | ${d.status} | ${d.verifiedAt ?? "—"} | ${d.reviewDue ?? "—"} | ${d.overdueDays} | ${d.reason} |`),
  "",
  due.length === 0
    ? "当前无逾期条目；仍需按季度核对平台规则变更并更新 `verifiedAt` / `reviewDue`。"
    : "处置：逐项核对官方规则 → 更新规格与 `verifiedAt`/`reviewDue` → 受影响任务按发布预检重新校验。",
];
mkdirSync(join(process.cwd(), "docs", "reports"), { recursive: true });
writeFileSync(join(process.cwd(), "docs", "reports", "external-facts-review.md"), lines.join("\n"), "utf8");
console.log(`外部事实复核：${specs.platforms.length} 条规格，待复核 ${due.length} 项（报告落 docs/reports/external-facts-review.md）`);
for (const item of due) console.log(`  ${item.overdueDays > 0 ? "✗" : "○"} ${item.id.padEnd(14)} ${item.reason}`);
if (process.argv.includes("--strict") && due.some((d) => d.overdueDays > 0)) process.exit(1);
