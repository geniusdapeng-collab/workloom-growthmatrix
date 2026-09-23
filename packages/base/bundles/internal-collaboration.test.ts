/**
 * B-62 通用规则模板 · 跨包用例：
 *  ① 同一模板按不同包前缀展开 → id 不冲突、语义逐字一致（G-C / H-C / V-C）；
 *  ② 未知模板名 / 非法前缀 / id 与包内既有规则冲突 → 装载期拒绝（fail-closed）；
 *  ③ geo-growth 基线不再手写 G-C01/G-C02（模板是唯一事实源），装配后三条模板规则随包装载。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyDeclaredFenceTemplates,
  expandInternalCollaborationTemplate,
  INTERNAL_COLLABORATION_TEMPLATE,
  loadInternalCollaborationTemplate,
} from "./internal-collaboration.js";
import { loadComposedAssets, mergeComposedFenceRules } from "./assembly.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const BASELINE = join(ROOT, "bundles/geo-growth/fences/geo-growth-baseline.yml");

describe("B-62 内部协作通用规则模板", () => {
  const template = loadInternalCollaborationTemplate();

  it("模板本体：三条基线规则（内部协作 auto / 花钱 review / 对外动作 review）", () => {
    expect(template.version).toBe("workloom.internal-collaboration/v1");
    expect(template.rules.map((r) => r.suffix)).toEqual(["01", "02", "03"]);
    expect(template.rules.map((r) => r.level)).toEqual(["auto", "review", "review"]);
    expect(template.rules.every((r) => r.is_baseline)).toBe(true);
  });

  it("跨包分发：三个前缀展开出三套互不冲突的 id，语义逐字一致", () => {
    const geo = expandInternalCollaborationTemplate(template, "G-C");
    const hotel = expandInternalCollaborationTemplate(template, "H-C");
    const video = expandInternalCollaborationTemplate(template, "V-C");
    expect(geo.map((r) => r.rule_id)).toEqual(["G-C01", "G-C02", "G-C03"]);
    expect(hotel.map((r) => r.rule_id)).toEqual(["H-C01", "H-C02", "H-C03"]);
    expect(video.map((r) => r.rule_id)).toEqual(["V-C01", "V-C02", "V-C03"]);
    const all = [...geo, ...hotel, ...video].map((r) => r.rule_id);
    expect(new Set(all).size).toBe(all.length);
    // 语义一致：除 id/前缀外，级别、条件、范围完全一致
    for (let i = 0; i < geo.length; i += 1) {
      expect(hotel[i]).toMatchObject({
        name: geo[i]!.name, level: geo[i]!.level, when: geo[i]!.when, is_baseline: true,
        match: { object_types: geo[i]!.match.object_types, actions: geo[i]!.match.actions },
      });
    }
    expect(geo.every((r) => r.version === template.version)).toBe(true);
  });

  it("fail-closed：非法前缀 / 未知模板名 / 与包内既有规则 id 冲突一律拒绝", () => {
    expect(() => expandInternalCollaborationTemplate(template, "geo")).toThrow(/前缀非法/);
    expect(() => expandInternalCollaborationTemplate(template, "G-C-X")).toThrow(/前缀非法/);
    expect(() => applyDeclaredFenceTemplates({
      version: "x/v1", rules: [], templates: [{ name: "unknown-template", prefix: "G-C" }],
    })).toThrow(/未知围栏规则模板/);
    expect(() => applyDeclaredFenceTemplates({
      version: "x/v1", rules: [{ rule_id: "G-C01", name: "手写重名规则", level: "auto", match: { object_types: ["content"], actions: ["draft"] }, when: "true" }],
      templates: [{ name: INTERNAL_COLLABORATION_TEMPLATE, prefix: "G-C" }],
    })).toThrow(/冲突/);
  });

  it("geo-growth 基线：不再手写 G-C01/G-C02（唯一事实源），装配后模板三规则随包装载", () => {
    const baseline = readFileSync(BASELINE, "utf-8");
    expect(baseline).toMatch(/templates:\n\s+- name: internal-collaboration\n\s+prefix: G-C/);
    expect(baseline).not.toMatch(/rule_id: G-C01/);
    expect(baseline).not.toMatch(/rule_id: G-C02/);

    const composed = loadComposedAssets("geo-growth", join(ROOT, "bundles"));
    const merged = mergeComposedFenceRules(composed.fencePacks);
    const derived = ["G-C01", "G-C02", "G-C03"].map((id) =>
      merged.find((m) => m.rule.rule_id === id));
    expect(derived.every(Boolean)).toBe(true);
    expect(derived.map((d) => d!.rule.level)).toEqual(["auto", "review", "review"]);
    expect(derived.every((d) => d!.rule.is_baseline !== false)).toBe(true);
    expect(derived.every((d) => d!.bundleId === "geo-growth")).toBe(true);
    // 规则身份唯一：模板派生不与其他包（调色 G-COL*）撞车
    const ids = merged.map((m) => m.rule.rule_id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
