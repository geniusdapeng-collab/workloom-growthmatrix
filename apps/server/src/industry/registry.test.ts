/**
 * 行业规划器注册表回归（IND-REG-01）。
 * 背景：`runQuestForThread` 曾对所有行业注入酒店规划器——增长工作区的目标被翻译成酒店语义，
 * 「增长目标 → 增长工具」走不到。本测试锁死：按行业取规划器、平台规格不静默回退、酒店回归不破。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AssembledPreset } from "@workloom/runtime";
import {
  clampTitle,
  detectMaterialKind,
  extractTitle,
  geoGrowthmatrixQuestPlanner,
  growthCoverPlan,
  growthGeneratePrompt,
  resolveGrowthPlatform,
} from "./geo-growthmatrix/planner.js";
import { industryPlannerFor, registeredIndustries } from "./registry.js";

const SAVED_OUT_DIR = process.env.WORKLOOM_VISUAL_BRIDGE_OUT_DIR;
afterEach(() => {
  if (SAVED_OUT_DIR === undefined) delete process.env.WORKLOOM_VISUAL_BRIDGE_OUT_DIR;
  else process.env.WORKLOOM_VISUAL_BRIDGE_OUT_DIR = SAVED_OUT_DIR;
});

function presetWith(tools: string[]): AssembledPreset {
  return {
    agentId: "agt-test",
    presetKey: "visual-designer",
    version: "v1.0",
    highRisk: false,
    fenceBindings: ["G-VIS1"],
    tools: tools.map((name) => ({ name, access: "write", desc: "test" })),
    prompt: {},
    essentials: { archive: {}, stage: "setup", goal: "测试目标" },
  };
}

const VISUAL_TOOLS = ["visualwrite.text", "visualwrite.compose", "visualread.verify", "visualwrite.generate"];

describe("平台解析（IND-REG-01）", () => {
  it("点名平台且在规格表内 → 用注册表数值（小红书 3:4 / 1080×1440）", () => {
    const r = resolveGrowthPlatform("给新品做一张小红书封面");
    expect(r?.kind).toBe("spec");
    if (r?.kind !== "spec") throw new Error("unreachable");
    expect(r.key).toBe("xiaohongshu");
    expect(r.width).toBe(1080);
    expect(r.height).toBe(1440);
    expect(r.ratio).toBe("3:4");
  });

  it("点名平台但规格表未收录 → 如实标注 unsupported（绝不回退默认平台）", () => {
    const r = resolveGrowthPlatform("做一张微博配图");
    expect(r).toEqual({ kind: "unsupported", matched: "微博" });
  });

  it("未点名平台 → undefined（不猜平台）", () => {
    expect(resolveGrowthPlatform("做一张促销海报")).toBeUndefined();
  });
});

describe("素材形态与标题（IND-REG-01）", () => {
  it("形态识别：答案卡 > 朋友圈 > 促销 > 海报 > 默认封面", () => {
    expect(detectMaterialKind("做一张 GEO 答案卡")).toBe("answer-card");
    expect(detectMaterialKind("来一组朋友圈九宫格")).toBe("moments");
    expect(detectMaterialKind("做一张开业促销图")).toBe("promo");
    expect(detectMaterialKind("做一张品牌海报")).toBe("poster");
    expect(detectMaterialKind("给这家店做张图")).toBe("cover");
  });

  it("标题只认显式标注；抽不到就不给（不把整句目标印上图）", () => {
    expect(extractTitle("做一张小红书封面，标题：「秋日限定下午茶」")).toBe("秋日限定下午茶");
    expect(extractTitle("做一张小红书封面 主题：亲子房")).toBe("亲子房");
    expect(extractTitle("做一张小红书封面")).toBeUndefined();
  });

  it("标题按平台上限截断", () => {
    expect(clampTitle("一二三四五六七八九十", 5)).toBe("一二三四五");
    expect(clampTitle("短标题", 12)).toBe("短标题");
  });
});

describe("平台化合成计划（IND-REG-01）", () => {
  it("有标题：文字 → 合成 → 校验 三步；画布与导出路径来自平台规格", () => {
    const platform = resolveGrowthPlatform("做一张小红书封面");
    if (platform?.kind !== "spec") throw new Error("unreachable");
    const steps = growthCoverPlan({ platform, kind: "cover", title: "秋日限定", outDir: "/tmp/out" });
    expect(steps.map((s) => s.tool)).toEqual(["visualwrite.text", "visualwrite.compose", "visualread.verify"]);
    const compose = steps[1]!;
    const recipe = (compose.params as { recipe: { canvas: { width: number; height: number }; exports: Array<{ path: string }> } }).recipe;
    expect(recipe.canvas.width).toBe(1080);
    expect(recipe.canvas.height).toBe(1440);
    expect(recipe.exports[0]!.path).toBe("/tmp/out/xiaohongshu-cover.png");
    const verify = steps[2]!;
    expect((verify.params as { path: string; width: number }).path).toBe("/tmp/out/xiaohongshu-cover.png");
    expect(steps[0]!.stepId).toBe("s1");
    expect(steps[2]!.stepId).toBe("s3");
  });

  it("无标题：只出底版（合成 → 校验）", () => {
    const platform = resolveGrowthPlatform("做一张抖音封面");
    if (platform?.kind !== "spec") throw new Error("unreachable");
    const steps = growthCoverPlan({ platform, kind: "cover", outDir: "/tmp/out" });
    expect(steps.map((s) => s.tool)).toEqual(["visualwrite.compose", "visualread.verify"]);
  });
});

describe("增长行业规划器（IND-REG-01）", () => {
  it("平台 + 工位目录齐备 → 平台化合成链", () => {
    process.env.WORKLOOM_VISUAL_BRIDGE_OUT_DIR = "/tmp/vis-out";
    const planner = geoGrowthmatrixQuestPlanner("做一张小红书封面，标题：「秋日限定」");
    const steps = planner("做一张小红书封面，标题：「秋日限定」", presetWith(VISUAL_TOOLS));
    expect(steps.map((s) => s.tool)).toEqual(["visualwrite.text", "visualwrite.compose", "visualread.verify"]);
  });

  it("无工位目录 → 单步 AI 生图降级，且提示词带平台规格", () => {
    delete process.env.WORKLOOM_VISUAL_BRIDGE_OUT_DIR;
    const goal = "给新品做一张小红书封面";
    const steps = geoGrowthmatrixQuestPlanner(goal)(goal, presetWith(VISUAL_TOOLS));
    expect(steps).toHaveLength(1);
    expect(steps[0]!.tool).toBe("visualwrite.generate");
    const prompt = (steps[0]!.params as { prompt: string }).prompt;
    expect(prompt).toContain("小红书");
    expect(prompt).toContain("1080×1440");
  });

  it("规格表外的平台：提示词如实说明未收录，且禁止套用其它平台规格", () => {
    delete process.env.WORKLOOM_VISUAL_BRIDGE_OUT_DIR;
    const goal = "做一张微博配图";
    const steps = geoGrowthmatrixQuestPlanner(goal)(goal, presetWith(VISUAL_TOOLS));
    const prompt = (steps[0]!.params as { prompt: string }).prompt;
    expect(prompt).toContain("规格表未收录");
    expect(prompt).toContain("禁止套用其它平台规格");
  });

  it("非视觉目标 → 交回基座确定性规划（不产出视觉步骤）", () => {
    const goal = "整理本周获客漏斗复盘";
    const steps = geoGrowthmatrixQuestPlanner(goal)(goal, presetWith(["lead.score.write", "funnel.report"]));
    expect(Array.isArray(steps)).toBe(true);
    expect(steps.some((s) => s.tool.startsWith("visualwrite."))).toBe(false);
  });

  it("视觉目标但岗位无视觉工具 → 仍交回基座规划（不伪造步骤）", () => {
    const goal = "做一张海报";
    const steps = geoGrowthmatrixQuestPlanner(goal)(goal, presetWith(["review.reply"]));
    expect(steps.some((s) => s.tool.startsWith("visualwrite."))).toBe(false);
  });
});

describe("行业注册表（IND-REG-01）", () => {
  it("已注册行业清单包含 hotel 与 geo-growthmatrix", () => {
    const list = registeredIndustries();
    expect(list).toContain("hotel");
    expect(list).toContain("geo-growthmatrix");
  });

  it("按行业取规划器；未注册/空行业返回 undefined（不注入行业规划器）", () => {
    expect(typeof industryPlannerFor("hotel", "处理一条差评")).toBe("function");
    expect(typeof industryPlannerFor("geo-growthmatrix", "做一张小红书封面")).toBe("function");
    expect(industryPlannerFor("unknown-industry", "随便")).toBeUndefined();
    expect(industryPlannerFor(null, "随便")).toBeUndefined();
    expect(industryPlannerFor(undefined, "随便")).toBeUndefined();
  });

  it("酒店规划器回归：差评目标仍直译为 review.reply 步骤（酒店语义未被增长规划器影响）", () => {
    const planner = industryPlannerFor("hotel", "处理一条 2 分差评并回复");
    if (!planner) throw new Error("hotel planner missing");
    const steps = planner("处理一条 2 分差评并回复", presetWith(["review.list", "review.reply"]));
    expect(steps.map((s) => s.tool)).toContain("review.reply");
  });
});

