import { describe, expect, it } from "vitest";
import { formatLoadtestReport, percentile, summarizeLatency } from "./loadtest.js";

describe("B-61 压测统计", () => {
  it("百分位：中位数与 p95；非法输入拒绝", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 0.5)).toBe(50);
    expect(percentile(values, 0.95)).toBe(95);
    expect(() => percentile([], 0.5)).toThrow(/至少 1 个样本/);
    expect(() => percentile([1], 1.5)).toThrow(/百分位非法/);
  });

  it("摘要：p50/p95/max/mean 与样本充足标注", () => {
    const summary = summarizeLatency([10, 20, 30, 40, 50]);
    expect(summary).toMatchObject({ count: 5, min: 10, max: 50, mean: 30, p50: 30, p95: 50, sampleSufficient: false });
    expect(summarizeLatency(Array.from({ length: 20 }, () => 15)).sampleSufficient).toBe(true);
  });

  it("报告含模型链/事件链两段与样本不足提示", () => {
    const text = formatLoadtestReport({
      modelChain: { samples: 5, summary: summarizeLatency([1, 2, 3, 4, 5]), modelIds: ["deepseek-v4-flash"] },
      eventChain: { samples: 100, summary: summarizeLatency(Array.from({ length: 100 }, () => 2)), throughputPerSecond: 1234.5 },
      generatedAt: "2026-09-22T02:00:00Z",
    });
    expect(text).toContain("模型链（mock 池）");
    expect(text).toContain("事件链（内存总线 append→ack）");
    expect(text).toContain("样本不足");
    expect(text).toContain("1234.5 次/秒");
  });
});
