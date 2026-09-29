/**
 * 行业规划器注册表（IND-REG-01）。
 *
 * 背景（2026-09-29 审计实证）：`runQuestForThread` 曾对**所有行业**注入酒店规划器——
 * 增长工作区的目标被翻译成酒店语义（调价/差评/工单），通用兜底又只会生成空参步骤，
 * 于是「增长目标 → 增长工具」这条路走不到。
 *
 * 口径：
 *  - 按工作区 `industry`（= 行业包 id）选择规划器；
 *  - 未注册的行业返回 undefined → 调用方不注入行业规划器，runQuest 退化为基座确定性规划（不猜、不吞）；
 *  - 注册表是**纯函数**，不做 IO（行业由调用方查好后传入），便于单测与复用。
 */
import type { QuestPlanner } from "@workloom/runtime";
import { acquisitionQuestPlanner } from "./hotel/acquisition-planner.js";
import { geoGrowthmatrixQuestPlanner } from "./geo-growthmatrix/planner.js";

/** 行业包 id → 规划器工厂。上游实验车道在建仓前使用 `geo-growth` 包名，这里一并兼容。 */
const PLANNER_FACTORIES: Record<string, (goal: string) => QuestPlanner> = {
  hotel: acquisitionQuestPlanner,
  "geo-growthmatrix": geoGrowthmatrixQuestPlanner,
  "geo-growth": geoGrowthmatrixQuestPlanner,
};

/** 已完成行业化的行业清单（供诊断/文档使用） */
export function registeredIndustries(): string[] {
  return Object.keys(PLANNER_FACTORIES).sort();
}

/** 取该行业的规划器；未注册行业返回 undefined（调用方不注入行业规划器） */
export function industryPlannerFor(industry: string | null | undefined, goal: string): QuestPlanner | undefined {
  if (!industry) return undefined;
  const factory = PLANNER_FACTORIES[industry.trim()];
  return factory ? factory(goal) : undefined;
}

