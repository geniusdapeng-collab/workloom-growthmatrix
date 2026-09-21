#!/usr/bin/env node
/**
 * event-freeze · 事件 Schema 冻结与对象枚举扩展门禁（B-83）
 *
 * 用法：tsx scripts/tools/event-freeze.mts [--update] [--strict]
 *  - 校验 packages/shared/src/event-schema.ts 的顶层字段与冻结清单一致；
 *  - 收集三包 schemas/objects.json 的对象类型，与 docs/event-object-freeze.json 差分；
 *  - --update 登记当前枚举（新增对象时显式更新）；--strict 有漂移即非 0；
 *  - 报告落 docs/reports/event-freeze.md。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FROZEN_EVENT_OPTIONAL_TOP_LEVEL, FROZEN_EVENT_TOP_LEVEL, diffObjectTypes, freezeGateSummary } from "@workloom/shared";

const root = process.cwd();
const freezePath = join(root, "docs", "event-object-freeze.json");
const systemTypes = [
  "thread", "task", "approval", "conversation", "company_ceo", "client", "workspace", "member", "store",
  "review", "secretary_reminder", "watchdog", "fence_rule", "circuit_breaker", "model_config", "budget_ledger",
];

function collectObjectTypes(): string[] {
  const types = new Set<string>(systemTypes);
  for (const bundleId of readdirSync(join(root, "bundles"))) {
    const file = join(root, "bundles", bundleId, "schemas", "objects.json");
    if (!existsSync(file)) continue;
    const doc = JSON.parse(readFileSync(file, "utf8")) as { objects?: Array<{ type?: unknown }> };
    for (const item of doc.objects ?? []) if (typeof item.type === "string") types.add(item.type);
  }
  return [...types].sort();
}

function declaredTopLevel(): string[] {
  const src = readFileSync(join(root, "packages", "shared", "src", "event-schema.ts"), "utf8");
  const block = src.slice(src.indexOf("export const FiveElementEventSchema"), src.indexOf("export type FiveElementEvent"));
  return [...block.matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]!);
}

const currentTypes = collectObjectTypes();
const declared = declaredTopLevel();
const topLevelIssues: string[] = [];
for (const field of FROZEN_EVENT_TOP_LEVEL) if (!declared.includes(field)) topLevelIssues.push(`schema 缺冻结顶层字段 ${field}`);
for (const field of declared) {
  if (![...FROZEN_EVENT_TOP_LEVEL, ...FROZEN_EVENT_OPTIONAL_TOP_LEVEL].includes(field as never)) {
    topLevelIssues.push(`schema 出现未冻结顶层字段 ${field}`);
  }
}

const frozen = existsSync(freezePath)
  ? (JSON.parse(readFileSync(freezePath, "utf8")) as { objectTypes?: string[] }).objectTypes ?? []
  : [];
const diff = frozen.length > 0 ? diffObjectTypes(frozen, currentTypes) : { added: currentTypes, removed: [] };

if (process.argv.includes("--update")) {
  writeFileSync(freezePath, `${JSON.stringify({
    schemaVersion: "workloom.event-object-freeze/v1",
    frozenAt: new Date().toISOString(),
    topLevel: [...FROZEN_EVENT_TOP_LEVEL],
    optionalTopLevel: [...FROZEN_EVENT_OPTIONAL_TOP_LEVEL],
    objectTypes: currentTypes,
  }, null, 2)}\n`, "utf8");
  console.log(`已登记事件对象冻结清单：${currentTypes.length} 类 → docs/event-object-freeze.json`);
}

const report = [
  "# 事件冻结门禁报告（B-83）",
  "",
  `> 生成时间：${new Date().toISOString()}`,
  "",
  "## 顶层字段",
  `- 冻结：${FROZEN_EVENT_TOP_LEVEL.join(" / ")}（可选：${FROZEN_EVENT_OPTIONAL_TOP_LEVEL.join(" / ")}）`,
  `- schema 声明：${declared.join(" / ")}`,
  topLevelIssues.length ? `- 违规：\n${topLevelIssues.map((i) => `  - ${i}`).join("\n")}` : "- 无违规",
  "",
  "## 对象枚举",
  freezeGateSummary({ added: frozen.length ? diff.added : [], removed: diff.removed }),
  `- 冻结登记：${frozen.length} 类；当前：${currentTypes.length} 类`,
].join("\n");
mkdirSync(join(root, "docs", "reports"), { recursive: true });
writeFileSync(join(root, "docs", "reports", "event-freeze.md"), report, "utf8");
console.log(report);
console.log("\n报告：docs/reports/event-freeze.md");
if (process.argv.includes("--strict") && (topLevelIssues.length > 0 || diff.added.length > 0 || diff.removed.length > 0)) process.exit(1);
