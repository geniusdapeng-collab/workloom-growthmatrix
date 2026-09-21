import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadModelPolicy } from "./policy.js";
import { buildScenarioCoverage, scenarioCoverageMarkdown, type PackagePolicy } from "./scenario-coverage.js";

const root = join(import.meta.dirname, "..", "..", "..", "bundles");

describe("B-60 场景覆盖审计", () => {
  it("跨包缺场景被标出，已声明场景解析出三套餐档位", () => {
    const policyOf = (scenes: Record<string, { tier: "L1" | "L2" | "L3" }>): PackagePolicy["policy"] => ({
      version: "v3.0", scenes: { generic: { tier: "L2" }, ...scenes },
      plans: { lite: { defaultShift: -1 }, standard: { defaultShift: 0 }, smart: { defaultShift: 1 } },
    }) as never;
    const result = buildScenarioCoverage([
      { packageId: "a", policy: policyOf({ "geo-content": { tier: "L2" }, "ceo-decision": { tier: "L2" } }) },
      { packageId: "b", policy: policyOf({ "geo-content": { tier: "L2" } }) },
    ]);
    expect(result.scenes).toEqual(["ceo-decision", "geo-content"]);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toMatchObject({ scene: "ceo-decision", packageId: "b" });
    const row = result.rows.find((r) => r.scene === "geo-content" && r.packageId === "a")!;
    expect(row.tiers).toEqual({ lite: "L1", standard: "L2", smart: "L3" });
    expect(scenarioCoverageMarkdown(result)).toContain("场景覆盖审计表");
    expect(scenarioCoverageMarkdown(result)).toContain("generic(L2)");
  });

  it("真实三包：声明条目约 51、并集去重后报告可生成（缺口如实列出）", () => {
    const packages: PackagePolicy[] = ["geo-growth", "hotel", "ai-video"].map((id) => {
      const loaded = loadModelPolicy(join(root, id));
      if (!loaded.policy) throw new Error(`${id} 模型策略装载失败`);
      return { packageId: id, policy: loaded.policy, issues: loaded.issues };
    });
    const result = buildScenarioCoverage(packages);
    expect(result.declarations).toBeGreaterThanOrEqual(40);
    expect(result.scenes.length).toBeGreaterThanOrEqual(20);
    expect(result.rows.length).toBe(result.scenes.length * packages.length);
    const markdown = scenarioCoverageMarkdown(result);
    expect(markdown).toContain("三包声明条目");
    expect(markdown).toContain("缺口");
  });
});
