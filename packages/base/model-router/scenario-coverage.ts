/**
 * model-router/scenario-coverage —— 跨包场景覆盖审计（B-60 / TECH-17）
 *
 * 背景：三包各自的 model-policy.yml 声明场景（合计约 51 个），但缺一张跨包合并的覆盖率
 * 审计表；某包缺某场景时会静默走 `generic`（L2），质量与成本口径因此漂移。
 *
 * 本模块把「场景 × 包 × 套餐 × 档位」拉平成可审计矩阵，并输出两类缺口：
 *  ① 跨包缺场景（别的包声明了、本包没有 → 走 generic）；
 *  ② 套餐覆盖引用未声明场景（策略配置错误）。
 */
import { resolveTier, type ModelPolicy, type PlanId } from "./policy.js";

export interface PackagePolicy {
  packageId: string;
  policy: ModelPolicy;
  /** parseModelPolicy 报告的 issues（套餐引用未声明场景等） */
  issues?: string[];
}

export interface ScenarioCoverageRow {
  scene: string;
  packageId: string;
  /** 该包是否显式声明（false = 将走 generic） */
  defined: boolean;
  tiers: Record<PlanId, "L1" | "L2" | "L3">;
}

export interface ScenarioCoverageGap {
  scene: string;
  packageId: string;
  reason: string;
}

export interface ScenarioCoverageResult {
  scenes: string[];
  /** 三包声明条目合计（含重复场景；计划口径的「51 个场景」） */
  declarations: number;
  rows: ScenarioCoverageRow[];
  gaps: ScenarioCoverageGap[];
}

export function buildScenarioCoverage(packages: PackagePolicy[], plans: PlanId[] = ["lite", "standard", "smart"]): ScenarioCoverageResult {
  const scenes = [...new Set(packages.flatMap((p) => Object.keys(p.policy.scenes).filter((s) => s !== "generic")))].sort();
  const rows: ScenarioCoverageRow[] = [];
  const gaps: ScenarioCoverageGap[] = [];
  for (const pkg of packages) {
    for (const scene of scenes) {
      const defined = Boolean(pkg.policy.scenes[scene]);
      const tiers = Object.fromEntries(plans.map((plan) => [plan, resolveTier(pkg.policy, scene, plan)])) as ScenarioCoverageRow["tiers"];
      rows.push({ scene, packageId: pkg.packageId, defined, tiers });
      if (!defined) {
        gaps.push({
          scene, packageId: pkg.packageId,
          reason: `场景未在本包声明（其他包已声明）→ 将回退 generic L2，档位与成本口径漂移`,
        });
      }
    }
    for (const issue of pkg.issues ?? []) {
      gaps.push({ scene: "(policy)", packageId: pkg.packageId, reason: issue });
    }
  }
  const declarations = packages.reduce(
    (sum, pkg) => sum + Object.keys(pkg.policy.scenes).filter((s) => s !== "generic").length,
    0,
  );
  return { scenes, declarations, rows, gaps };
}

export function scenarioCoverageMarkdown(result: ScenarioCoverageResult): string {
  const byScene = new Map<string, ScenarioCoverageRow[]>();
  for (const row of result.rows) byScene.set(row.scene, [...(byScene.get(row.scene) ?? []), row]);
  const lines = [
    "# 场景覆盖审计表（B-60）",
    "",
    `> 三包声明条目：${result.declarations}｜场景并集：${result.scenes.length}｜审计行：${result.rows.length}｜缺口：${result.gaps.length}`,
    "",
    "| 场景 | " + [...new Set(result.rows.map((r) => r.packageId))].join(" | ") + " |",
    "|---|" + [...new Set(result.rows.map((r) => r.packageId))].map(() => "---").join("|") + "|",
    ...[...byScene.entries()].map(([scene, rows]) =>
      `| ${scene} | ${rows.map((r) => r.defined ? `${r.tiers.lite}/${r.tiers.standard}/${r.tiers.smart}` : "generic(L2)").join(" | ")} |`),
    "",
    "## 缺口",
    "",
    result.gaps.length === 0
      ? "无缺口：三包场景齐全且套餐覆盖引用有效。"
      : result.gaps.map((g) => `- [${g.packageId}] ${g.scene}：${g.reason}`).join("\n"),
  ];
  return lines.join("\n");
}
