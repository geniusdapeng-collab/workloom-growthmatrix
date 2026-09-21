/**
 * model-router/loadtest —— 事件链与模型链压测统计（B-61 / TECH-14）
 *
 * 纯函数：百分位与延迟摘要（p50/p95/max/mean），供 `scripts/tools/loadtest.mts` 复跑引用。
 * 纪律：样本不足不给结论（sampleSize < 20 → 标注「样本不足」）。
 */

export interface LatencySummary {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  sampleSufficient: boolean;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) throw new Error("percentile 需要至少 1 个样本");
  if (!(p > 0 && p <= 1)) throw new Error(`百分位非法：${p}`);
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[index]!;
}

export function summarizeLatency(samples: number[], minSampleSize = 20): LatencySummary {
  if (samples.length === 0) throw new Error("summarizeLatency 需要至少 1 个样本");
  const sum = samples.reduce((acc, v) => acc + v, 0);
  return {
    count: samples.length,
    min: Math.min(...samples),
    max: Math.max(...samples),
    mean: Number((sum / samples.length).toFixed(2)),
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    sampleSufficient: samples.length >= minSampleSize,
  };
}

export function formatLoadtestReport(input: {
  modelChain: { samples: number; summary: LatencySummary; modelIds: string[] };
  eventChain: { samples: number; summary: LatencySummary; throughputPerSecond: number };
  generatedAt?: string;
}): string {
  const when = input.generatedAt ?? new Date().toISOString();
  const line = (s: LatencySummary) =>
    `n=${s.count} p50=${s.p50}ms p95=${s.p95}ms mean=${s.mean}ms max=${s.max}ms${s.sampleSufficient ? "" : "（样本不足 <20，不作结论）"}`;
  return [
    "# 事件链与模型链压测（B-61）",
    "",
    `> 生成时间：${when}`,
    "",
    "## 模型链（mock 池）",
    `- 模型：${input.modelChain.modelIds.join(" / ")}`,
    `- 延迟：${line(input.modelChain.summary)}`,
    "",
    "## 事件链（内存总线 append→ack）",
    `- 写入吞吐：${input.eventChain.throughputPerSecond.toFixed(1)} 次/秒`,
    `- 延迟：${line(input.eventChain.summary)}`,
  ].join("\n");
}
