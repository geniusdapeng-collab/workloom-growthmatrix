import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GROWTH_MATRIX_VERSION,
  formatMatrixGaps,
  loadGrowthMatrix,
  matrixGapReport,
  matrixStats,
  parseGrowthMatrix,
  type GrowthMatrix,
} from "./matrix.js";

const bundleMatrixPath = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "bundles",
  "geo-growth",
  "matrix",
  "content-platform-matrix.yml",
);

const sample = {
  version: GROWTH_MATRIX_VERSION,
  classes: [{
    key: "A",
    label: "品牌调性物料",
    items: [{
      id: "A1",
      name: "品牌形象主视觉",
      platforms: ["小红书"],
      accountSlots: ["官方号"],
      targets: ["T6"],
      owner: "visual-designer",
      fences: ["G-VIS1"],
    }],
  }],
};

describe("获客内容矩阵", () => {
  it("主包矩阵可加载且覆盖 12 大类 123 个内容子类", () => {
    const matrix = loadGrowthMatrix(bundleMatrixPath);
    const stats = matrixStats(matrix);
    expect(stats.classes).toBe(12);
    expect(stats.items).toBe(123);
    expect(Object.keys(stats.byTarget).sort()).toEqual(["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8"]);
    for (const klass of matrix.classes) {
      for (const item of klass.items) {
        expect(item.platforms.length).toBeGreaterThan(0);
        expect(item.targets.length).toBeGreaterThan(0);
        expect(item.owner).toMatch(/^[a-z][a-z0-9-]+$/);
      }
    }
  });

  it("结构非法即拒绝：重复编号、越界目标、空平台", () => {
    const duplicate = structuredClone(sample) as Record<string, unknown>;
    (duplicate.classes as Array<{ items: unknown[] }>)[0]!.items.push((duplicate.classes as Array<{ items: unknown[] }>)[0]!.items[0]);
    expect(() => parseGrowthMatrix(JSON.stringify(duplicate), "duplicate")).toThrow(/重复/);

    const badTarget = structuredClone(sample) as Record<string, any>;
    badTarget.classes[0].items[0].targets = ["T9"];
    expect(() => parseGrowthMatrix(JSON.stringify(badTarget), "target")).toThrow();

    const emptyPlatforms = structuredClone(sample) as Record<string, any>;
    emptyPlatforms.classes[0].items[0].platforms = [];
    expect(() => parseGrowthMatrix(JSON.stringify(emptyPlatforms), "platform")).toThrow();
  });

  it("缺口报告如实列出未登记岗位、围栏与平台", () => {
    const doc = structuredClone(sample) as Record<string, any>;
    doc.classes[0].items[0].owner = "ghost-role";
    doc.classes[0].items[0].fences = ["G-NOPE"];
    doc.classes[0].items[0].platforms = ["小红书", "不存在平台"];
    const matrix = parseGrowthMatrix(JSON.stringify(doc), "gap");
    const gaps = matrixGapReport(matrix, {
      owners: ["visual-designer"],
      fences: ["G-VIS1"],
      platforms: ["小红书", "xhs"],
    });
    expect(gaps.map((gap) => gap.kind).sort()).toEqual(["unknown-fence", "unknown-owner", "unknown-platform"]);
    expect(formatMatrixGaps(gaps)).toContain("矩阵缺口：3 项");
  });

  it("缺省引用集合时只做目标与账号位完整性检查", () => {
    const doc = structuredClone(sample) as Record<string, any>;
    doc.classes[0].items[0].accountSlots = [];
    const matrix = parseGrowthMatrix(JSON.stringify(doc), "partial") as GrowthMatrix;
    const gaps = matrixGapReport(matrix);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.kind).toBe("slot-missing");
  });
});
