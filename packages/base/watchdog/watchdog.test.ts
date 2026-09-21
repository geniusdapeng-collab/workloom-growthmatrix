/**
 * B-35 看门狗纯函数测试：cron 周期、漏触发、连接器陈旧、审批 SLA 三档。
 */
import { describe, expect, it } from "vitest";
import {
  checkApprovals, checkConnectors, checkTriggers, cronIntervalMinutes, summarizeFindings,
} from "./index.js";

const now = new Date("2026-09-22T12:00:00Z");

describe("B-35 触发器漏触发", () => {
  it("cron → 近似周期：*/30 → 30m、*/2 小时 → 120m、每日 → 1440m、每周/每月", () => {
    expect(cronIntervalMinutes("*/30 * * * *")).toBe(30);
    expect(cronIntervalMinutes("7 */2 * * *")).toBe(120);
    expect(cronIntervalMinutes("0 7 * * *")).toBe(1440);
    expect(cronIntervalMinutes("0 9 * * 1")).toBe(10080);
    expect(cronIntervalMinutes("0 10 1 * *")).toBe(43200);
    expect(cronIntervalMinutes("bad cron")).toBeNull();
  });

  it("1.5× 警告、2× 严重、从未触发警告、停用跳过", () => {
    const findings = checkTriggers([
      { triggerId: "t-1", name: "半小时任务", schedule: "*/30 * * * *", lastFiredAt: new Date(now.getTime() - 50 * 60_000).toISOString(), enabled: true },
      { triggerId: "t-2", name: "两小时任务", schedule: "7 */2 * * *", lastFiredAt: new Date(now.getTime() - 300 * 60_000).toISOString(), enabled: true },
      { triggerId: "t-3", name: "新任务", schedule: "0 7 * * *", lastFiredAt: null, enabled: true },
      { triggerId: "t-4", name: "停用任务", schedule: "*/30 * * * *", lastFiredAt: null, enabled: false },
    ], now);
    expect(findings.find((f) => f.subject === "t-1")?.severity).toBe("warn");
    expect(findings.find((f) => f.subject === "t-2")?.severity).toBe("critical");
    expect(findings.find((f) => f.subject === "t-3")?.detail).toContain("从未触发");
    expect(findings.find((f) => f.subject === "t-4")).toBeUndefined();
  });
});

describe("B-35 连接器与审批 SLA", () => {
  it("连接器：unconfigured 警告、error 严重、ready 但陈旧警告", () => {
    const findings = checkConnectors([
      { id: "pms", name: "PMS", state: "unconfigured", lastSuccessAt: null },
      { id: "wecom", name: "企微", state: "error", lastSuccessAt: null },
      { id: "ota", name: "OTA", state: "ready", lastSuccessAt: new Date(now.getTime() - 200 * 60_000).toISOString() },
      { id: "ads", name: "广告", state: "ready", lastSuccessAt: new Date(now.getTime() - 10 * 60_000).toISOString() },
    ], now);
    expect(findings.find((f) => f.subject === "pms")?.severity).toBe("warn");
    expect(findings.find((f) => f.subject === "wecom")?.severity).toBe("critical");
    expect(findings.find((f) => f.subject === "ota")?.severity).toBe("warn");
    expect(findings.find((f) => f.subject === "ads")).toBeUndefined();
  });

  it("审批 SLA：超 1× 警告、超 2× 严重、已决跳过", () => {
    const findings = checkApprovals([
      { approvalId: "a-1", tier: "l2_captain", createdAt: new Date(now.getTime() - 5 * 3600_000).toISOString(), status: "pending" },
      { approvalId: "a-2", tier: "l4_chairman", createdAt: new Date(now.getTime() - 26 * 3600_000).toISOString(), status: "pending" },
      { approvalId: "a-3", tier: "l2_captain", createdAt: new Date(now.getTime() - 100 * 3600_000).toISOString(), status: "approved" },
    ], now);
    expect(findings.find((f) => f.subject === "a-1")?.severity).toBe("warn");
    expect(findings.find((f) => f.subject === "a-2")?.severity).toBe("critical");
    expect(findings.find((f) => f.subject === "a-3")).toBeUndefined();
    expect(summarizeFindings(findings)).toContain("严重 1 / 警告 1");
    expect(summarizeFindings([])).toContain("无异常");
  });
});
