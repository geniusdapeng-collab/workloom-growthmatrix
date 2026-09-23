import { describe, expect, it } from "vitest";
import { checkEventTopLevel, diffObjectTypes, freezeGateSummary } from "./event-freeze.js";

describe("B-83 事件 Schema 冻结门禁", () => {
  it("五元完整 + 可选 receipt/model_trace → 通过；缺字段/未知顶层 → 违规", () => {
    const ok = {
      event_id: "E-1", who: {}, context: {}, object: {}, decision: {}, rule_impact: [],
      receipt: {}, model_trace: {}, links: ["E-0"], hash: "sha256:abc", ts: "2026-09-24T00:00:00+08:00",
    };
    expect(checkEventTopLevel(ok)).toEqual([]);
    const missing = checkEventTopLevel({ event_id: "E-1", who: {}, context: {}, object: {}, decision: {} });
    expect(missing.map((v) => v.field)).toEqual(["rule_impact"]);
    const missingId = checkEventTopLevel({ who: {}, context: {}, object: {}, decision: {}, rule_impact: [] });
    expect(missingId.map((v) => v.field)).toEqual(["event_id"]);
    const extra = checkEventTopLevel({ ...ok, industry_ext: {} });
    expect(extra[0]?.kind).toBe("unknown-top-level");
    expect(extra[0]?.detail).toContain("顶层字段 industry_ext");
  });

  it("对象枚举差分：新增/删除分别列出；无漂移提示", () => {
    const diff = diffObjectTypes(["a", "b"], ["a", "b", "c"]);
    expect(diff).toEqual({ added: ["c"], removed: [] });
    expect(diffObjectTypes(["a", "b"], ["a"])).toEqual({ added: [], removed: ["b"] });
    expect(freezeGateSummary({ added: [], removed: [] })).toContain("无漂移");
    expect(freezeGateSummary(diff)).toContain("新增对象 c");
  });
});
