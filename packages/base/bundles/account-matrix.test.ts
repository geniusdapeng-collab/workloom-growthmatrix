/**
 * B-46 账号矩阵编排测试：真实资产可装载、结构校验、防关联（G16）、日上限与窗口。
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadAccountMatrix, planAccountSchedule, summarizeAccountMatrix, validateAccountMatrix,
  type AccountMatrixDoc,
} from "./account-matrix.js";

const realBundleDir = join(import.meta.dirname, "..", "..", "..", "bundles", "geo-growth");

function makeDoc(over: Partial<AccountMatrixDoc> = {}): AccountMatrixDoc {
  return {
    version: "test/v1",
    layers: [
      { key: "l1_brand", label: "品牌层", duty: "品牌", target: "T6", discipline: "G9" },
      { key: "l2_store", label: "门店层", duty: "日常", target: "T1", discipline: "G16" },
    ],
    accounts: [
      {
        id: "a-brand-1", layer: "l1_brand", platform: "douyin", handle: "@brand",
        ownerPreset: "publish-operator", deviceGroup: "dg-1", networkGroup: "net-1",
        dailyLimit: 2, windows: ["09:00-18:00"],
      },
      {
        id: "a-store-1", layer: "l2_store", platform: "douyin", handle: "@store",
        ownerPreset: "publish-operator", deviceGroup: "dg-1", networkGroup: "net-1",
        dailyLimit: 2, windows: ["09:00-18:00"],
      },
    ],
    ...over,
  };
}

describe("B-46 账号矩阵装载与校验", () => {
  it("真实资产：geo-growth 账号矩阵可装载、8 层、9 账号、0 结构问题", () => {
    const doc = loadAccountMatrix(realBundleDir);
    expect(doc.layers).toHaveLength(8);
    expect(doc.accounts).toHaveLength(9);
    expect(validateAccountMatrix(doc)).toEqual([]);
    expect(doc.accounts.every((a) => a.dailyLimit >= 1 && a.ownerPreset)).toBe(true);
  });

  it("结构校验：id 重复、层级缺失、日上限非法一次报全", () => {
    const doc = makeDoc();
    doc.accounts.push({ ...doc.accounts[0]!, id: "a-brand-1", layer: "l9_missing", dailyLimit: 0 });
    const issues = validateAccountMatrix(doc);
    expect(issues.join("；")).toContain("账号 id 重复");
    expect(issues.join("；")).toContain("引用未声明层级");
    expect(issues.join("；")).toContain("daily_limit 非法");
  });

  it("文件缺失/空账号 → 抛错（不静默）", () => {
    const dir = mkdtempSync(join(tmpdir(), "acct-matrix-"));
    expect(() => loadAccountMatrix(dir)).toThrow(/account-matrix\.yml 不存在/);
    mkdirSync(join(dir, "library"), { recursive: true });
    writeFileSync(join(dir, "library", "account-matrix.yml"), "version: t\naccounts: []\n");
    expect(() => loadAccountMatrix(dir)).toThrow(/未声明任何账号/);
  });
});

describe("B-46 协同排期（G16 防关联 + 日上限 + 窗口）", () => {
  it("同设备组/网络组同一小时并发 → G16 冲突（后到者被拒）", () => {
    const plan = planAccountSchedule(makeDoc(), [
      { id: "s1", accountId: "a-brand-1", at: "2026-09-22T10:05:00+08:00" },
      { id: "s2", accountId: "a-store-1", at: "2026-09-22T10:40:00+08:00" },
    ]);
    expect(plan.accepted.map((s) => s.id)).toEqual(["s1"]);
    expect(plan.conflicts[0]).toMatchObject({ slotId: "s2", rule: "G16" });
  });

  it("不同小时可并排；单账号超日上限被拒", () => {
    const slots = [
      { id: "d1", accountId: "a-brand-1", at: "2026-09-22T09:10:00+08:00" },
      { id: "d2", accountId: "a-brand-1", at: "2026-09-22T11:10:00+08:00" },
      { id: "d3", accountId: "a-brand-1", at: "2026-09-22T13:10:00+08:00" },
    ];
    const plan = planAccountSchedule(makeDoc(), slots);
    expect(plan.accepted.map((s) => s.id)).toEqual(["d1", "d2"]);
    expect(plan.conflicts[0]).toMatchObject({ slotId: "d3", rule: "daily-limit" });
  });

  it("窗口外发布被拒；未知账号被拒", () => {
    const plan = planAccountSchedule(makeDoc(), [
      { id: "w1", accountId: "a-brand-1", at: "2026-09-22T22:10:00+08:00" },
      { id: "w2", accountId: "ghost", at: "2026-09-22T10:00:00+08:00" },
    ]);
    expect(plan.accepted).toHaveLength(0);
    expect(plan.conflicts.map((c) => c.rule).sort()).toEqual(["unknown-account", "window"]);
  });

  it("分层容量汇总（编制周报口径）：层容量 = 账号数 × 日上限", () => {
    const stats = summarizeAccountMatrix(makeDoc());
    expect(stats.find((s) => s.layer === "l1_brand")).toMatchObject({ accounts: 1, dailyCapacity: 2 });
  });
});
