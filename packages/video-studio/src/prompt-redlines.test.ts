import { describe, expect, it } from "vitest";
import { auditFilmRedlines, auditShotRedlines, PROMPT_REDLINE_POLICY_VERSION } from "./prompt-redlines.js";

const base = { shotId: "T-01", scene: "酒店大堂", sceneDescription: "明亮通透的大堂", action: "她开口", props: "自助入住机", negative: "无卡通、无文字水印" };

describe("花钱前提示词红线（提高一次过率）", () => {
  it.each([
    "无额外道具，仅人物本身与虚化的大堂环境，画面中不出现屏幕、卡片、单据或可读标识。",
    "出镜人物本人为画面唯一主体；不出现房卡、单据、证件或可读标识。",
    "画面中没有证件、菜单或书页。",
    "无房卡、单据、屏幕。",
  ])("否定顿号清单不被拆成肯定道具：%s", props => {
    expect(auditShotRedlines({ ...base, props }).filter(issue => issue.hard)).toEqual([]);
  });
  it.each([
    "不出现房卡、单据，屏幕显示可读界面。",
    "不出现房卡、单据、屏幕显示可读界面。",
    "机身无LOGO、屏幕正面可见。",
  ])("否定不掩盖后续明确肯定的屏幕：%s", props => {
    expect(auditShotRedlines({ ...base, props }).map(issue => issue.id)).toContain("screen-must-be-blurred");
  });
  it("肯定枚举与后续证件动作仍按隐私红线拒绝", () => {
    for (const props of ["台式机、身份证、房卡", "不出现单据、手持身份证放到感应区"]) {
      expect(auditShotRedlines({ ...base, props }).map(issue => issue.id)).toContain("document-must-be-unreadable");
    }
  });
  it("屏幕镜头必须写明虚化 + 负面排除文字与 LOGO", () => {
    const bad = auditShotRedlines({ ...base, sceneDescription: "机器触控面亮着界面" });
    expect(bad.map((i) => i.id)).toEqual(expect.arrayContaining(["screen-must-be-blurred", "screen-no-text-negative", "screen-no-logo-negative"]));
    const good = auditShotRedlines({ ...base, sceneDescription: "触控面只呈现柔和光晕（界面内容虚化不可辨认）", negative: "无界面文字、无图标、无LOGO、无屏幕可读文字" });
    expect(good.filter((i) => i.hard)).toEqual([]);
  });
  it("证件镜头必须不可辨认并排除字迹号码（隐私红线）", () => {
    const bad = auditShotRedlines({ ...base, props: "身份证放到感应区" });
    expect(bad.map((i) => i.id)).toEqual(expect.arrayContaining(["document-must-be-unreadable", "document-no-text-negative"]));
  });
  it("卡片类道具要约束数量，避免幻影道具", () => {
    expect(auditShotRedlines({ ...base, props: "房卡吐出" }).map((i) => i.id)).toContain("prop-duplication");
  });
  it("时间轴说定住、运镜没写定住 → 拦截", () => {
    expect(auditShotRedlines({ ...base, timeline: "T00:02.5–T00:06 完全定住", camera_movement: "缓推" }).map((i) => i.id)).toContain("camera-timeline-mismatch");
  });
  it("帧率不一致 → 拦截；整片汇总区分 hard/soft", () => {
    expect(auditShotRedlines({ ...base, constraint: "9:16画幅，1080x1920，30fps，MP4格式" }, { fps: 24 }).map((i) => i.id)).toContain("fps-mismatch");
    const film = auditFilmRedlines([{ ...base, sceneDescription: "落地窗" }, { ...base, shotId: "T-02" }], { fps: 24 });
    expect(film.policy).toBe(PROMPT_REDLINE_POLICY_VERSION);
    expect(film.soft.length).toBeGreaterThan(0);
  });
});
