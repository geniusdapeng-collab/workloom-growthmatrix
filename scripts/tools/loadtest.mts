#!/usr/bin/env node
/**
 * loadtest · 事件链与模型链压测（B-61）
 *
 * 用法：tsx --env-file=.env scripts/tools/loadtest.mts [--models 200] [--events 1000] [--strict]
 * mock 池下复跑（确定性、零外部依赖）：模型链 p50/p95 与事件总线 append 吞吐；
 * --strict 时模型 p95 > LOADTEST_MODEL_P95_MS（默认 50）或事件 p95 > LOADTEST_EVENT_P95_MS（默认 5）非 0。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryEventBus } from "@workloom/base/event-bus";
import { MODEL_CATALOG, formatLoadtestReport, poolFromEnv, summarizeLatency } from "@workloom/base/model-router";

const argOf = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1] ?? fallback) : fallback;
};
const modelSamples = argOf("--models", 200);
const eventSamples = argOf("--events", 1000);

const pool = poolFromEnv();
const modelIds = MODEL_CATALOG.slice(0, Math.min(3, MODEL_CATALOG.length)).map((m) => m.id);
const modelLatencies: number[] = [];
for (let i = 0; i < modelSamples; i += 1) {
  const provider = pool.get(modelIds[i % modelIds.length]!)!;
  const t0 = performance.now();
  await provider.chat([{ role: "user", content: `压测样本 ${i}：输出一句经营建议` }]);
  modelLatencies.push(Number((performance.now() - t0).toFixed(3)));
}

const bus = new MemoryEventBus(["workloom.test"]);
const eventLatencies: number[] = [];
const tStart = performance.now();
for (let i = 0; i < eventSamples; i += 1) {
  const t0 = performance.now();
  bus.publish("workloom.test", `subject.${i % 10}`, { seq: i, at: new Date().toISOString() });
  eventLatencies.push(Number((performance.now() - t0).toFixed(3)));
}
const elapsedSeconds = (performance.now() - tStart) / 1000;

const report = formatLoadtestReport({
  modelChain: { samples: modelLatencies.length, summary: summarizeLatency(modelLatencies), modelIds },
  eventChain: {
    samples: eventLatencies.length,
    summary: summarizeLatency(eventLatencies),
    throughputPerSecond: eventSamples / Math.max(elapsedSeconds, 0.001),
  },
});
mkdirSync(join(process.cwd(), "docs", "reports"), { recursive: true });
writeFileSync(join(process.cwd(), "docs", "reports", "loadtest.md"), report, "utf8");
console.log(report);
console.log("\n报告：docs/reports/loadtest.md");

const modelP95Limit = Number(process.env.LOADTEST_MODEL_P95_MS ?? 50);
const eventP95Limit = Number(process.env.LOADTEST_EVENT_P95_MS ?? 5);
if (process.argv.includes("--strict")) {
  const model = summarizeLatency(modelLatencies);
  const events = summarizeLatency(eventLatencies);
  if (model.p95 > modelP95Limit || events.p95 > eventP95Limit) {
    console.error(`压测超阈值：模型 p95 ${model.p95}ms > ${modelP95Limit} 或事件 p95 ${events.p95}ms > ${eventP95Limit}`);
    process.exit(1);
  }
}
