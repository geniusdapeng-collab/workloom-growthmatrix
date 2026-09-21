import { describe, expect, it } from "vitest";
import { filterGrowthPreferences, growthPreferenceBlock, usedGrowthPreferenceIds } from "./growth-preference.js";
import type { InjectedPreference } from "./preference-inject.js";

const prefs: InjectedPreference[] = [
  { memoryId: "m-1", kind: "preference", content: "投放预算超带必须升级 L4", confidence: 0.9 },
  { memoryId: "m-2", kind: "preference", content: "客户不喜欢周二发内容", confidence: 0.7 },
  { memoryId: "m-3", kind: "preference", content: "报价一律走确认单", confidence: 0.95 },
];

describe("B-58 增长线偏好注入", () => {
  it("只保留增长相关偏好并按置信度排序；limit 生效", () => {
    const filtered = filterGrowthPreferences(prefs);
    expect(filtered.map((p) => p.memoryId)).toEqual(["m-1", "m-2"]);
    expect(filterGrowthPreferences(prefs, { limit: 1 }).map((p) => p.memoryId)).toEqual(["m-1"]);
    expect(filterGrowthPreferences(prefs, { minConfidence: 0.8 }).map((p) => p.memoryId)).toEqual(["m-1"]);
  });

  it("偏好块含记忆 id 与置信度；无命中返回空串", () => {
    const block = growthPreferenceBlock(filterGrowthPreferences(prefs));
    expect(block).toContain("【增长线偏好");
    expect(block).toContain("m-1");
    expect(block).toContain("90%");
    expect(growthPreferenceBlock([])).toBe("");
  });

  it("引用留痕：去重保序", () => {
    expect(usedGrowthPreferenceIds([
      { scene: "campaign-strategy", preferenceIds: ["m-1", "m-3"] },
      { scene: "content-generate", preferenceIds: ["m-1", "m-2"] },
    ])).toEqual(["m-1", "m-3", "m-2"]);
  });
});
