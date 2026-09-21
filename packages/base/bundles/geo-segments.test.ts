/**
 * B-48 获客主包「起步方式」测试：四个客群可解析、引用零断链、幂等、P2 条件岗默认不出场。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listSegments, resolveSegment } from "./segment.js";

const bundleDir = join(import.meta.dirname, "..", "..", "..", "bundles", "geo-growth");
const EXPECTED = ["growth_starter", "local_business", "b2b_lead", "budget_guard"];
const P2_ROLES = ["lifecycle-growth-officer", "growth-partnership-officer"];

describe("B-48 geo-growth 起步方式（segment-defaults）", () => {
  it("声明四个客群且顺序稳定", () => {
    const keys = listSegments(bundleDir).map((s) => s.key);
    expect(keys).toEqual(EXPECTED);
  });

  for (const key of EXPECTED) {
    it(`${key}：引用零断链、班组与技能达到起步规模`, () => {
      const seg = resolveSegment(bundleDir, key);
      expect(seg.presets.length).toBeGreaterThanOrEqual(5);
      expect(seg.skillsOrdered.length).toBeGreaterThanOrEqual(4);
      expect(seg.presetFiles.every((f) => existsSync(f))).toBe(true);
      expect(seg.skillDirs.every((d) => existsSync(d))).toBe(true);
      expect(seg.pitch).not.toBe("");
    });

    it(`${key}：解析幂等（同输入同输出）且 P2 条件岗默认不出场`, () => {
      const a = resolveSegment(bundleDir, key);
      const b = resolveSegment(bundleDir, key);
      expect(a).toEqual(b);
      expect(a.presets.some((p) => P2_ROLES.includes(p))).toBe(false);
    });
  }

  it("未知客群报错并列出可选值", () => {
    expect(() => resolveSegment(bundleDir, "nope")).toThrow(/未知客群/);
  });
});
