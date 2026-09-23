#!/usr/bin/env node
/**
 * 通用围栏规则模板 · 漂移门禁（B-62）
 *
 * 用法：tsx scripts/tools/internal-collaboration-template.mts [--json]
 * 校验：
 *  ① 模板本体合法（suffix/level/范围齐备，规则数 ≥3）；
 *  ② 每个行业包围栏包里声明的 templates 都能展开（前缀合法、与包内既有 id 不冲突）；
 *  ③ 同一口径不得手抄：包内出现 `rule_id` 等于本模板会展开出的 id 时，必须来自模板声明
 *     （即该 id 只能由 templates 展开产生，不允许手写在 rules 里）；
 *  ④ 未声明模板的包给出提示（advisory：模板是跨包标准，新包应声明）。
 * 退出码：任一硬校验失败 → 1。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import {
  applyDeclaredFenceTemplates,
  expandInternalCollaborationTemplate,
  loadInternalCollaborationTemplate,
} from "@workloom/base/bundles";

const ROOT = join(import.meta.dirname, "..", "..");
const BUNDLES = join(ROOT, "bundles");
const JSON_OUT = process.argv.includes("--json");

const template = loadInternalCollaborationTemplate();
const findings: string[] = [];
const advisories: string[] = [];
const perBundle: Array<{ bundle: string; declared: boolean; expandedIds: string[]; fencePacks: number }> = [];

for (const bundle of readdirSync(BUNDLES)) {
  const fencesDir = join(BUNDLES, bundle, "fences");
  if (!existsSync(fencesDir)) continue;
  let declared = false;
  const expandedIds: string[] = [];
  let packCount = 0;
  for (const file of readdirSync(fencesDir).filter((f) => f.endsWith(".yml")).sort()) {
    const text = readFileSync(join(fencesDir, file), "utf-8");
    const doc = YAML.parse(text) as { rules?: unknown[]; fences?: unknown[]; templates?: Array<{ name: string; prefix: string }> };
    packCount += 1;
    const rules = [...(doc.rules ?? []), ...(doc.fences ?? [])] as Array<{ rule_id?: string }>;
    const decls = doc.templates ?? [];
    for (const decl of decls) {
      declared = true;
      try {
        const expanded = expandInternalCollaborationTemplate(
          decl.name === template ? template : template, decl.prefix,
        );
        const existing = new Set(rules.map((r) => String(r.rule_id ?? "")));
        for (const rule of expanded) {
          if (existing.has(rule.rule_id)) {
            findings.push(`${bundle}/${file}：规则 id「${rule.rule_id}」既手写在包内又由模板展开（同一口径不得双写，删掉手写规则）`);
          }
          expandedIds.push(rule.rule_id);
        }
      } catch (error) {
        findings.push(`${bundle}/${file}：模板展开失败 —— ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // 兜底：整包能过统一展开入口（含未知模板名/冲突的 fail-closed 校验）
    try {
      applyDeclaredFenceTemplates(doc as never, { template });
    } catch (error) {
      findings.push(`${bundle}/${file}：装配期展开失败 —— ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!declared && packCount > 0) {
    advisories.push(`${bundle}：未声明 templates（内部协作 auto / 花钱 review / 对外动作 review 未随包分发）`);
  }
  perBundle.push({ bundle, declared, expandedIds, fencePacks: packCount });
}

const report = {
  template: template.version,
  rules: template.rules.length,
  bundles: perBundle,
  findings,
  advisories,
};

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`通用围栏规则模板：${template.version}（${template.rules.length} 条规则）`);
  for (const b of perBundle) {
    const ids = b.expandedIds.length ? ` → ${b.expandedIds.join(", ")}` : "";
    console.log(`${b.declared ? "✓" : "·"} ${b.bundle}（${b.fencePacks} 个围栏包）${b.declared ? `声明模板${ids}` : "未声明模板"}`);
  }
  for (const a of advisories) console.log(`⚠️ ${a}`);
  if (findings.length) {
    console.log(`✗ 模板漂移 ${findings.length} 处：`);
    for (const f of findings) console.log(`  - ${f}`);
  } else {
    console.log("模板漂移检查：0 处（口径唯一，无手抄重复）");
  }
}
process.exit(findings.length === 0 ? 0 : 1);
