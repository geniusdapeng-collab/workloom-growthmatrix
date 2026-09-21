import { describe, expect, it } from "vitest";
import { extendNightCandidates, summarizeNightCandidates } from "./candidates-extension.js";

describe("B-59 夜班候选扩展", () => {
  it("三类候选追加且与既有候选去重；建议岗位正确", () => {
    const base = [{ id: "nt-existing", name: "例行巡检", type: "night", estCredits: 5, fenceSummary: "—", presetKey: "entity-inspector" }];
    const items = extendNightCandidates(base, {
      matrixGaps: ["抖音缺互动目标"], experimentsDue: ["落地页 A/B"], materialGaps: ["周三缺主图"],
    });
    expect(items).toHaveLength(4);
    expect(items.find((i) => i.type === "matrix-gap")?.presetKey).toBe("geo-content-planner");
    expect(items.find((i) => i.type === "growth-experiment")?.presetKey).toBe("growth-experimenter");
    expect(items.find((i) => i.type === "material-gap")?.fenceSummary).toContain("降级产出");
    const again = extendNightCandidates(items, { matrixGaps: ["抖音缺互动目标"], experimentsDue: [], materialGaps: [] });
    expect(again).toHaveLength(4);
    expect(summarizeNightCandidates(again)).toContain("夜班候选 4 项");
    expect(summarizeNightCandidates(again)).toContain("matrix-gap×1");
  });
});
