/**
 * B-68 默认装载裁剪断言：P2 条件岗默认不出场、商单/分账管线默认不排触发器、演示主入口固定。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const root = join(import.meta.dirname, "..", "..", "..", "bundles");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("B-68 默认装载裁剪", () => {
  it("geo-growth 起步方式默认不含 P2 条件岗与分账/商单岗", () => {
    const doc = YAML.parse(read("geo-growth/segment-defaults.yml")) as {
      segments: Record<string, { presets: string[] }>;
    };
    const defaults = Object.values(doc.segments).flatMap((s) => s.presets);
    expect(defaults).not.toContain("lifecycle-growth-officer");
    expect(defaults).not.toContain("growth-partnership-officer");
    expect(defaults).not.toContain("settlement-clerk");
    expect(defaults).not.toContain("deal-manager");
  });

  it("三包默认触发器不含商单/分账/结算节拍（默认不排）", () => {
    for (const bundle of ["geo-growth", "hotel", "ai-video"]) {
      const file = join(root, bundle, "triggers.yml");
      if (!existsSync(file)) continue;
      const doc = YAML.parse(readFileSync(file, "utf8")) as {
        triggers?: Array<{ id: string; action?: { template?: string; dispatch?: string } }>;
      };
      const text = JSON.stringify(doc.triggers ?? []);
      for (const needle of ["settlement", "deal.", "recon"]) {
        expect(text, `${bundle} 默认触发器含 ${needle}`).not.toContain(needle);
      }
    }
  });

  it("电影级技能库与分账管线保留在包内但默认不进入segment清单", () => {
    const doc = YAML.parse(read("geo-growth/segment-defaults.yml")) as {
      segments: Record<string, { skills_ordered: string[] }>;
    };
    const skills = Object.values(doc.segments).flatMap((s) => s.skills_ordered);
    expect(skills.some((s) => s.includes("hollywood"))).toBe(false);
    // 资产保留可查（技能市场/后续安装入口）
    const aiVideoPipelines = readdirSync(join(root, "ai-video", "pipelines"));
    expect(aiVideoPipelines).toContain("settlement-recon.yml");
  });
});
