/**
 * B-30 模型配置版本台账测试。
 */
import { describe, expect, it } from "vitest";
import { buildRollbackCommand, diffModelConfig, summarizeModelLedger } from "./ledger.js";

const base = [
  { scene: "intent-route", tier: "L1" as const, model: "deepseek-v4-flash" },
  { scene: "deep-analysis", tier: "L3" as const, model: "glm-5.3", noDowngrade: true },
];

describe("B-30 模型配置 diff 与回滚", () => {
  it("只输出真实变化：模型切换/档位变化/新增/移除", () => {
    const next = [
      { scene: "intent-route", tier: "L1" as const, model: "glm-5.3-flash" },
      { scene: "deep-analysis", tier: "L3" as const, model: "glm-5.3", noDowngrade: true },
      { scene: "content-generate", tier: "L2" as const, model: "deepseek-v4-pro" },
    ];
    const changes = diffModelConfig(base, next);
    expect(changes.map((c) => c.scene).sort()).toEqual(["content-generate", "intent-route"]);
    expect(changes.find((c) => c.scene === "intent-route")).toMatchObject({
      from: "deepseek-v4-flash", to: "glm-5.3-flash", fromTier: "L1", toTier: "L1",
    });
    expect(changes.find((c) => c.scene === "content-generate")?.from).toBe("(unset)");
    const removed = diffModelConfig(base, [base[0]!]);
    expect(removed).toEqual([expect.objectContaining({ scene: "deep-analysis", to: "(removed)" })]);
  });

  it("无变化 → 空 diff；回滚命令可复跑且带场景", () => {
    expect(diffModelConfig(base, [...base])).toEqual([]);
    const change = diffModelConfig(base, [{ ...base[0]!, model: "qwen-3.8-flash" }, base[1]!])[0]!;
    expect(buildRollbackCommand(change)).toBe("tsx scripts/model-ledger.mts --set intent-route=deepseek-v4-flash");
  });

  it("台账摘要含变更、noDowngrade 与回滚命令", () => {
    const text = summarizeModelLedger([{
      at: "2026-09-22T02:00:00Z", by: "MEM-001", reason: "旗舰降本",
      changes: diffModelConfig(base, [{ scene: "deep-analysis", tier: "L3", model: "kimi-k3", noDowngrade: true }]),
    }]);
    expect(text).toContain("模型配置台账（1 次变更）");
    expect(text).toContain("deep-analysis: glm-5.3 → kimi-k3");
    expect(text).toContain("noDowngrade");
    expect(text).toContain("--set deep-analysis=glm-5.3");
    expect(summarizeModelLedger([])).toContain("无变更记录");
  });
});
