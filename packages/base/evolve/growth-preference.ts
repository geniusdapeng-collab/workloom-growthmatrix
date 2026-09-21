/**
 * evolve/growth-preference —— 增长线偏好注入（B-58 / TECH-19）
 *
 * 背景：组织偏好已能注入执行链路，但增长线（实验/预算/内容决策）没有专用过滤与留痕口径。
 * 本模块把「哪些偏好与增长决策相关」变成确定性函数，并输出可留痕的引用块与引用 id。
 */
import type { InjectedPreference } from "./preference-inject.js";

export const GROWTH_PREFERENCE_KEYWORDS = [
  "增长", "预算", "实验", "内容", "投放", "承接", "私域", "复购", "转介", "蓄水", "获客",
] as const;

export interface GrowthPreferenceFilter {
  subjectId?: string;
  keywords?: readonly string[];
  minConfidence?: number;
  limit?: number;
}

/** 过滤增长线相关偏好：关键词命中 + 置信度下限；按置信度降序，limit 截断。 */
export function filterGrowthPreferences(
  prefs: InjectedPreference[], opts: GrowthPreferenceFilter = {},
): InjectedPreference[] {
  const keywords = opts.keywords ?? GROWTH_PREFERENCE_KEYWORDS;
  const minConfidence = opts.minConfidence ?? 0;
  return prefs
    .filter((p) => p.confidence >= minConfidence)
    .filter((p) => keywords.some((k) => p.content.includes(k)))
    .sort((a, b) => b.confidence - a.confidence || a.memoryId.localeCompare(b.memoryId))
    .slice(0, opts.limit ?? Number.POSITIVE_INFINITY);
}

/** 增长线偏好块（注入提示词/决策包；无命中返回空串，不占位）。 */
export function growthPreferenceBlock(prefs: InjectedPreference[]): string {
  if (prefs.length === 0) return "";
  return [
    "【增长线偏好（来自组织记忆，需在决策依据中引用）】",
    ...prefs.map((p) => `- (${p.memoryId} · 置信 ${(p.confidence * 100).toFixed(0)}%) ${p.content}`),
  ].join("\n");
}

/** 增长决策引用留痕：返回决策实际引用到的偏好 id（去重、保序）。 */
export function usedGrowthPreferenceIds(
  decisions: Array<{ scene: string; preferenceIds: string[] }>,
): string[] {
  const seen = new Set<string>();
  const used: string[] = [];
  for (const decision of decisions) {
    for (const id of decision.preferenceIds) {
      if (!seen.has(id)) {
        seen.add(id);
        used.push(id);
      }
    }
  }
  return used;
}
