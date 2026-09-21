/**
 * shared/event-freeze —— 事件 Schema 冻结与对象枚举扩展门禁（B-83）
 *
 * 纪律（附录 E）：
 *  - 事件**顶层五元字段冻结**：who / context / object / decision / rule_impact（可选 receipt/model_trace）；
 *    行业扩展只能在 context/object/decision 内部加字段，禁止新增顶层字段；
 *  - 对象枚举只增不改：新增 object.type 必须在冻结清单登记（本模块 + docs/event-object-freeze.json），
 *    防止「悄悄加对象」绕过契约与投影治理。
 */

export const FROZEN_EVENT_TOP_LEVEL = ["who", "context", "object", "decision", "rule_impact"] as const;
export const FROZEN_EVENT_OPTIONAL_TOP_LEVEL = ["receipt", "model_trace"] as const;
export type FrozenTopLevel = (typeof FROZEN_EVENT_TOP_LEVEL)[number];

export interface FreezeViolation {
  kind: "missing-top-level" | "unknown-top-level";
  field: string;
  detail: string;
}

/** 校验事件负载顶层字段：缺五元或出现未知顶层字段 → 违规。 */
export function checkEventTopLevel(payload: unknown): FreezeViolation[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [{ kind: "missing-top-level", field: "(payload)", detail: "事件负载必须是对象" }];
  }
  const keys = new Set(Object.keys(payload as Record<string, unknown>));
  const violations: FreezeViolation[] = [];
  for (const field of FROZEN_EVENT_TOP_LEVEL) {
    if (!keys.has(field)) violations.push({ kind: "missing-top-level", field, detail: `缺少冻结顶层字段 ${field}` });
  }
  const allowed = new Set<string>([...FROZEN_EVENT_TOP_LEVEL, ...FROZEN_EVENT_OPTIONAL_TOP_LEVEL]);
  for (const key of keys) {
    if (!allowed.has(key)) {
      violations.push({
        kind: "unknown-top-level", field: key,
        detail: `顶层字段 ${key} 未在冻结清单内；行业扩展请放进 context/object/decision 内部`,
      });
    }
  }
  return violations;
}

export interface ObjectTypeDiff {
  added: string[];
  removed: string[];
}

/** 对象枚举差分：新增需登记冻结清单；删除属破坏性变更（需提案）。 */
export function diffObjectTypes(frozen: readonly string[], current: readonly string[]): ObjectTypeDiff {
  const frozenSet = new Set(frozen);
  const currentSet = new Set(current);
  return {
    added: [...currentSet].filter((t) => !frozenSet.has(t)).sort(),
    removed: [...frozenSet].filter((t) => !currentSet.has(t)).sort(),
  };
}

export function freezeGateSummary(diff: ObjectTypeDiff): string {
  if (diff.added.length === 0 && diff.removed.length === 0) return "事件冻结门禁：对象枚举无漂移";
  const lines = ["事件冻结门禁：对象枚举漂移"];
  for (const type of diff.added) lines.push(`  + 新增对象 ${type}（需登记 docs/event-object-freeze.json 并说明用途）`);
  for (const type of diff.removed) lines.push(`  - 删除对象 ${type}（破坏性变更：需提案与迁移方案）`);
  return lines.join("\n");
}
