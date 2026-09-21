/**
 * B-51 直播通用模板与切片管线测试：模板/管线/触发器三件套齐备且引用零断链。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const dir = join(import.meta.dirname, "..", "..", "..", "bundles", "ai-video");
const read = (p: string) => readFileSync(join(dir, p), "utf8");
const manifest = JSON.parse(read("bundle.json")) as {
  workloom: { provides: { pipelines: string[]; library: string[]; presets: string[] } };
};

describe("B-51 直播模板", () => {
  it("脚本模板含节奏五段与切片复用/合规自检", () => {
    const text = read("library/templates/live-script-template.md");
    for (const clause of ["开场引流", "福利款", "主推款", "逼单", "切片复用", "合规自检", "价格与权益"]) {
      expect(text, `脚本模板缺：${clause}`).toContain(clause);
    }
  });

  it("战报模板含 GMV/核销口径分列、切片表现与异常改进", () => {
    const text = read("library/templates/live-battle-report.md");
    for (const clause of ["GMV", "核销", "不以支付冒充核销", "切片表现", "异常与改进"]) {
      expect(text, `战报模板缺：${clause}`).toContain(clause);
    }
  });

  it("模板与管线都在 ai-video 清单声明且文件存在", () => {
    const wanted = [
      "library/templates/live-script-template.md",
      "library/templates/live-battle-report.md",
      "pipelines/live-clip-reuse.yml",
    ];
    expect(manifest.workloom.provides.library).toEqual(expect.arrayContaining(wanted.slice(0, 2)));
    expect(manifest.workloom.provides.pipelines).toContain(wanted[2]!);
    expect(wanted.every((p) => existsSync(join(dir, p)))).toBe(true);
  });
});

describe("B-51 切片管线与触发器", () => {
  it("管线：quest 唯一、owner 在编、gate 存在、outputs 已声明", () => {
    const pipelineFiles = readdirSync(join(dir, "pipelines")).filter((f) => f.endsWith(".yml"));
    const quests = pipelineFiles.map((f) => (YAML.parse(read(`pipelines/${f}`)) as { quest: string }).quest);
    expect(new Set(quests).size).toBe(quests.length);

    const presets = new Set(manifest.workloom.provides.presets.map((p) => p.replace("presets/", "").replace(".yml", "")));
    const fenceIds = new Set<string>();
    for (const file of readdirSync(join(dir, "fences")).filter((f) => f.endsWith(".yml"))) {
      const doc = YAML.parse(read(`fences/${file}`)) as { rules?: Array<{ rule_id: string }> };
      for (const rule of doc.rules ?? []) fenceIds.add(rule.rule_id);
    }
    const objectTypes = new Set<string>(
      (JSON.parse(read("schemas/objects.json")) as { objects: Array<{ type: string }> }).objects.map((o) => o.type),
    );
    const pipeline = YAML.parse(read("pipelines/live-clip-reuse.yml")) as {
      steps: Array<{ step_key: string; owner: string; gate?: string; outputs?: string[] }>;
    };
    expect(pipeline.steps.length).toBeGreaterThanOrEqual(6);
    for (const step of pipeline.steps) {
      expect(presets.has(step.owner), `owner 不在编：${step.owner}`).toBe(true);
      if (step.gate) expect(fenceIds.has(step.gate), `gate 未声明：${step.gate}`).toBe(true);
      for (const out of step.outputs ?? []) {
        expect(objectTypes.has(out), `output 未声明：${out}`).toBe(true);
      }
    }
  });

  it("触发器：切片复用扫描已声明且 dispatch 在编", () => {
    const triggers = YAML.parse(read("triggers.yml")) as {
      triggers: Array<{ id: string; action: { dispatch?: string; template?: string } }>;
    };
    const trigger = triggers.triggers.find((t) => t.id === "tg-live-clip-reuse");
    expect(trigger).toBeTruthy();
    expect(trigger!.action.dispatch).toBe("post-editor");
    expect(trigger!.action.template).toBe("clip.reuse.scan");
  });
});
