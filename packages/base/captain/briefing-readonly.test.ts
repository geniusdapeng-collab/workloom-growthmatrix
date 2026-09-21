/**
 * B-49 只读岗位发现进晨报固定栏位（REF-P-08 / SCALE-05）。
 */
import { describe, expect, it } from "vitest";
import { composeBriefing, type BriefFacts } from "./briefing.js";

const facts = (over: Partial<BriefFacts> = {}): BriefFacts => ({
  kpi: { 事件库规模: "10 条（哈希链可验）" },
  actionsTop: [{ action: "report.weekly", n: 2 }],
  pendingByTier: { l2_captain: 1, l4_chairman: 2 },
  incidents: 1,
  ...over,
});

describe("B-49 只读岗位发现栏位", () => {
  it("有发现时固定成栏：标签｜岗位：动作 ×次数", () => {
    const text = composeBriefing("daily", facts({
      readonlyFindings: [
        { agent: "品质巡检官", label: "巡检发现", action: "inspection.scan", n: 3 },
        { agent: "市场侦察官", label: "竞对侦察", action: "competitor.fetch", n: 2 },
        { agent: "业主驾驶舱", label: "驾驶舱汇聚", action: "cockpit.kpi", n: 1 },
      ],
    }), "云栖酒店");
    expect(text).toContain("五、只读岗位发现（巡检/竞对/驾驶舱）");
    expect(text).toContain("巡检发现｜品质巡检官：inspection.scan ×3");
    expect(text).toContain("竞对侦察｜市场侦察官：competitor.fetch ×2");
    expect(text).toContain("驾驶舱汇聚｜业主驾驶舱：cockpit.kpi ×1");
  });

  it("无发现时不虚报栏位；定制中心仍接在风险栏之后（编号连续）", () => {
    const noFindings = composeBriefing("daily", facts(), "云栖酒店");
    expect(noFindings).not.toContain("只读岗位发现");
    const withOverlay = composeBriefing("daily", facts({
      overlayHealth: { drafts: 2, staleDrafts: 1, staleCanaries: 0 },
    }), "云栖酒店");
    expect(withOverlay).toContain("五、定制中心");
    const both = composeBriefing("daily", facts({
      readonlyFindings: [{ agent: "品质巡检官", label: "巡检发现", action: "inspection.scan", n: 1 }],
      overlayHealth: { drafts: 2, staleDrafts: 0, staleCanaries: 0 },
    }), "云栖酒店");
    expect(both).toContain("五、只读岗位发现");
    expect(both).toContain("六、定制中心");
  });
});
