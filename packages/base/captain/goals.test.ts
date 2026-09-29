/**
 * 目标与指标事实源 · 纯逻辑回归（GOAL-KPI-01）。
 * 背景：偏差节拍此前读不到 goal.tracking、熔断/回测写死酒店指标名——
 * 本测试锁死「偏差口径」与「行业无关日汇总载荷」这两处纯计算。
 * 数据库路径（setGoal/ingestMetric/refreshGoalTracking 的事务与 RLS）由场景套件与真机验收覆盖。
 */
import { describe, expect, it } from "vitest";
import { computeDeviationPt, summaryPayloadFrom } from "./goals.js";

describe("偏差口径（GOAL-KPI-01）", () => {
  it("落后为负、超前为正，保留 1 位小数", () => {
    expect(computeDeviationPt(100, 80)).toBe(-20);
    expect(computeDeviationPt(100, 120)).toBe(20);
    expect(computeDeviationPt(30, 28)).toBe(-6.7);
    expect(computeDeviationPt(30, 30)).toBe(0);
  });

  it("目标为 0 时不做除法：同为 0 记 0，有值时记 100", () => {
    expect(computeDeviationPt(0, 0)).toBe(0);
    expect(computeDeviationPt(0, 5)).toBe(100);
  });

  it("非有限输入一律记 0（不把 NaN 带进偏差节拍）", () => {
    expect(computeDeviationPt(Number.NaN, 10)).toBe(0);
    expect(computeDeviationPt(10, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("±5pt 阈值语义：4.9 不立项、5.1 立项（与 runDeviationBeat 的 threshold=5 对齐）", () => {
    const near = computeDeviationPt(100, 95.1);
    const far = computeDeviationPt(100, 94.9);
    expect(Math.abs(near) < 5).toBe(true);
    expect(Math.abs(far) >= 5).toBe(true);
  });
});

describe("日汇总载荷（GOAL-KPI-01）", () => {
  it("指标名原样作为键（行业无关：增长指标与酒店指标都能被消费方按名取到）", () => {
    expect(summaryPayloadFrom("有效询盘数", 12)).toMatchObject({ 有效询盘数: 12 });
    expect(summaryPayloadFrom("occ", 0.82)).toMatchObject({ occ: 0.82 });
    expect(summaryPayloadFrom("adr", 512)).toMatchObject({ adr: 512 });
  });

  it("额外指标可与主指标同时下发（一次汇总承载多个 KPI，供 kpi_floor 逐项比对）", () => {
    const payload = summaryPayloadFrom("有效询盘数", 12, { 询盘成本: 38.5, ai引用率: 0.21 });
    expect(payload["有效询盘数"]).toBe(12);
    expect(payload["询盘成本"]).toBe(38.5);
    expect(payload["ai引用率"]).toBe(0.21);
  });

  it("载荷只含数值（时间戳为数值），消费方无需再解析字符串", () => {
    const payload = summaryPayloadFrom("m", 1);
    for (const [key, value] of Object.entries(payload)) {
      expect(typeof value, `字段 ${key} 应为数值`).toBe("number");
      expect(Number.isFinite(value)).toBe(true);
    }
  });
});

