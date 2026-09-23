/**
 * 通用围栏规则模板 · 内部协作 auto / 对外动作 review（B-62，覆盖 REF-P-06）
 *
 * 为什么要有这一层：这套协作口径此前**手抄在每个行业包的基线里**，于是
 *   ① 新增行业包必抄一遍（漏抄 = 内部协作被默认级 review 挂起，真机实测过）；
 *   ② 抄错/抄漏无人发现（三包口径漂移）；
 *   ③ 修一处要改三处（改漏即口径分裂）。
 * 现在模板是唯一事实源：行业包在围栏包里声明
 *   `templates: [{ name: internal-collaboration, prefix: G-C }]`
 * 装配期按前缀展开为该包自己的 rule_id（G-C01/H-C01/V-C01…），语义完全一致。
 *
 * 纪律：
 *  - 未知模板名 / 非法前缀 / 空规则集 → 装载期直接抛错（fail-closed，不静默跳过）；
 *  - 展开结果一律 is_baseline=true（只可加严）；
 *  - 展开后的 id 与包内既有规则 id 冲突 → 抛错（规则身份必须唯一，否则单调守卫与 dry-run 会作用错规则）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import YAML from "yaml";
import { fenceRulesOf } from "../fence-engine/dsl.js";

export const INTERNAL_COLLABORATION_TEMPLATE = "internal-collaboration";

const TemplateRuleSchema = z.object({
  suffix: z.string().regex(/^[0-9]{2}[a-z]?$/, "suffix 形如 01 / 02a"),
  name: z.string().min(1),
  level: z.enum(["auto", "review", "block"]),
  is_baseline: z.boolean().default(true),
  match: z.object({
    object_types: z.array(z.string().min(1)).min(1),
    actions: z.array(z.string().min(1)).min(1),
  }),
  when: z.string(),
  note: z.string().optional(),
});

const TemplateSchema = z.object({
  version: z.string().min(1),
  description: z.string().optional(),
  rules: z.array(TemplateRuleSchema).min(1),
});

export type InternalCollaborationTemplate = z.infer<typeof TemplateSchema>;
export type InternalCollaborationTemplateRule = z.infer<typeof TemplateRuleSchema>;

export interface ExpandedFenceRule {
  rule_id: string;
  version: string;
  name: string;
  level: "auto" | "review" | "block";
  is_baseline: boolean;
  match: { object_types: string[]; actions: string[] };
  when: string;
  note?: string;
}

export interface FenceTemplateDeclaration { name: string; prefix: string }

function templateDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "templates");
}

/** 装载模板（默认 `packages/base/bundles/templates/internal-collaboration.yml`） */
export function loadInternalCollaborationTemplate(
  file = join(templateDir(), `${INTERNAL_COLLABORATION_TEMPLATE}.yml`),
): InternalCollaborationTemplate {
  const parsed = TemplateSchema.safeParse(YAML.parse(readFileSync(file, "utf-8")));
  if (!parsed.success) {
    throw new Error(`围栏规则模板非法（${file}）：${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}：${i.message}`).join("；")}`);
  }
  return parsed.data;
}

const PREFIX_PATTERN = /^[A-Z]-[A-Z]$/;

/**
 * 按前缀展开模板规则：`prefix=G-C` + `suffix=01` → `rule_id=G-C01`。
 * 前缀非法 / 展开后 id 重复 → 抛错（fail-closed）。
 */
export function expandInternalCollaborationTemplate(
  template: InternalCollaborationTemplate,
  prefix: string,
): ExpandedFenceRule[] {
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new Error(`围栏模板前缀非法「${prefix}」：需形如 G-C（字母-字母）`);
  }
  const seen = new Set<string>();
  return template.rules.map((rule) => {
    const ruleId = `${prefix}${rule.suffix}`;
    if (seen.has(ruleId)) throw new Error(`围栏模板展开出重复规则 id：${ruleId}`);
    seen.add(ruleId);
    return {
      rule_id: ruleId,
      version: template.version,
      name: rule.name,
      level: rule.level,
      is_baseline: rule.is_baseline !== false,
      match: { object_types: [...rule.match.object_types], actions: [...rule.match.actions] },
      when: rule.when,
      ...(rule.note ? { note: rule.note } : {}),
    };
  });
}

interface PackLike {
  version?: string;
  rules?: unknown[];
  fences?: unknown[];
  templates?: FenceTemplateDeclaration[];
}

/**
 * 装配期入口：把围栏包声明的模板展开并追加到该包规则列表（保持包版本口径）。
 * 返回新对象（不改写传入对象），便于测试与幂等重放。
 */
export function applyDeclaredFenceTemplates<T extends PackLike>(
  pack: T,
  opts: { template?: InternalCollaborationTemplate } = {},
): T {
  const declared = pack.templates ?? [];
  if (declared.length === 0) return pack;
  const rules = [...(fenceRulesOf(pack as never) as unknown[])] as Array<Record<string, unknown>>;
  const existing = new Set(rules.map((r) => String(r.rule_id ?? "")));
  for (const decl of declared) {
    if (decl.name !== INTERNAL_COLLABORATION_TEMPLATE) {
      throw new Error(`未知围栏规则模板「${decl.name}」（可用：${INTERNAL_COLLABORATION_TEMPLATE}）`);
    }
    const template = opts.template ?? loadInternalCollaborationTemplate();
    for (const rule of expandInternalCollaborationTemplate(template, decl.prefix)) {
      if (existing.has(rule.rule_id)) {
        throw new Error(`围栏模板展开的规则 id「${rule.rule_id}」与包内既有规则冲突（规则身份必须唯一）`);
      }
      existing.add(rule.rule_id);
      rules.push(rule as unknown as Record<string, unknown>);
    }
  }
  return { ...pack, rules: rules as unknown[] };
}
