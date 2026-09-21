/**
 * night-shift/candidates-extension —— 夜班候选扩展（B-59）
 *
 * 在原有「夜班员工例行 + 审批积压」之外，追加三类经营候选：
 *  ① 矩阵缺口（GrowthMatrix 缺平台/缺目标/缺岗位）；
 *  ② 增长实验待跑（实验卡已批未跑）；
 *  ③ 素材缺口（内容排期缺图/缺片）。
 * 仅生成候选（人确认后开启夜班），不自动执行。
 */
import type { CandidateItem } from "./candidates.js";

export interface NightExtensionInput {
  matrixGaps: string[];
  experimentsDue: string[];
  materialGaps: string[];
}

export function extendNightCandidates(base: CandidateItem[], input: NightExtensionInput): CandidateItem[] {
  const existing = new Set(base.map((item) => item.id));
  const extra: CandidateItem[] = [
    ...input.matrixGaps.map((gap, i) => ({
      id: `nt-matrix-${i}-${gap}`.slice(0, 80),
      name: `补齐矩阵缺口：${gap}`,
      type: "matrix-gap",
      estCredits: 6,
      fenceSummary: "G-MX1 矩阵未登记禁排产；夜班只出补位草案，登记仍需人确认",
      presetKey: "geo-content-planner",
    })),
    ...input.experimentsDue.map((exp, i) => ({
      id: `nt-experiment-${i}-${exp}`.slice(0, 80),
      name: `待跑实验：${exp}`,
      type: "growth-experiment",
      estCredits: 10,
      fenceSummary: "G-GROW1 预算带内；超带/对外投放仍需 L4",
      presetKey: "growth-experimenter",
    })),
    ...input.materialGaps.map((gap, i) => ({
      id: `nt-material-${i}-${gap}`.slice(0, 80),
      name: `素材缺口：${gap}`,
      type: "material-gap",
      estCredits: 8,
      fenceSummary: "视觉工位/桥不可用时走降级出图（B-81），产物标「降级产出」",
      presetKey: "material-scout",
    })),
  ].filter((item) => !existing.has(item.id));
  return [...base, ...extra];
}

export function summarizeNightCandidates(items: CandidateItem[]): string {
  const byType = new Map<string, number>();
  for (const item of items) byType.set(item.type, (byType.get(item.type) ?? 0) + 1);
  const credits = items.reduce((sum, item) => sum + item.estCredits, 0);
  return `夜班候选 ${items.length} 项（预估 ${credits} 积分）：` +
    [...byType.entries()].map(([type, n]) => `${type}×${n}`).join(" · ");
}
