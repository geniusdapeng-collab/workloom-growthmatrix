import { describe, expect, it } from "vitest";
import { assessFilmFirstPass, assessShotFirstPass, FIRST_PASS_POLICY_VERSION } from "./first-pass.js";

describe("一次过就绪度（花钱前判定）", () => {
  it("画面里让模型'别写字'的镜头判高风险，并给出移出画面的建议", () => {
    const r = assessShotFirstPass({ shotId: "S1", sceneDescription: "机器触控面亮着界面", props: "身份证放到感应区", negative: "无文字水印" });
    expect(r.blockers.map((b) => b.id)).toEqual(expect.arrayContaining(["text-in-frame:screen", "text-in-frame:document"]));
    expect(r.suggestions.join()).toContain("移出取景");
  });
  it("已把风险物移出画面/虚化 → 不算阻塞", () => {
    const r = assessShotFirstPass({ shotId: "S2", sceneDescription: "只拍机身背面与取卡口，画面内不出现屏幕" , props: "房卡", negative: "无多余手指" });
    expect(r.blockers).toEqual([]);
  });
  it("秒级'定住'与推镜并存 → 高风险（模型做不到）", () => {
    const r = assessShotFirstPass({ shotId: "S3", timeline: "T00:02.5–T00:06 完全定住", camera_movement: "缓推后定住" });
    expect(r.blockers.map((b) => b.id)).toContain("timing-lock-vs-motion");
  });
  it("明确无推拉摇移与停止移动不是肯定运镜，不误拦固定机位", () => {
    const r = assessShotFirstPass({ timeline: "T00:03.8-T00:04 镜头定住", camera_movement: "全程固定机位，无推拉摇移，机位停止移动，保持轻微呼吸感" });
    expect(r.blockers.map(b => b.id)).not.toContain("timing-lock-vs-motion");
  });
  it("前段推近与后段同窗口定住分离，边界相接不算重叠；输入不改变", () => {
    const shot = { timeline: "T00:00-T00:04.9 缓推；T00:04.9-T00:05 镜头定住", camera_movement: "T00:00-T00:04.9 匀速推近；T00:04.9-T00:05 镜头定住，机位停止移动，构图保持" };
    const before = structuredClone(shot);
    expect(assessShotFirstPass(shot).blockers.map(b => b.id)).not.toContain("timing-lock-vs-motion");
    expect(shot).toEqual(before);
  });
  it.each([
    "T00:00-T00:05 缓推后定住",
    "T00:00-T00:04.95 推近；T00:04.95-T00:05 定住",
    "T00:00-T00:04.8 推近；T00:04.95-T00:05 定住",
    "T00:00-T00:04.9 推近；T00:04.9-T00:05 定住但继续后拉",
    "T00:00-T00:04.9 推近；T00:05-T00:04.9 定住",
    "缓推后定住",
  ])("有真实运动重叠/静止缺口/无时段的运镜仍阻断：%s", camera_movement => {
    const r = assessShotFirstPass({ timeline: "T00:04.9-T00:05 镜头定住", camera_movement });
    expect(r.blockers.map(b => b.id)).toContain("timing-lock-vs-motion");
  });
  it("无抖动不能遮盖同分句的肯定推近；否定清单后新增肯定运动仍阻断", () => {
    for (const camera_movement of ["固定机位无抖动并继续推近", "无推、拉、摇、移，随后继续推近"]) {
      expect(assessShotFirstPass({ timeline: "T00:02-T00:04 定住", camera_movement }).blockers.map(b => b.id)).toContain("timing-lock-vs-motion");
    }
  });
  it("客户的造型意图（面料/配饰）与同镜多诉求只作提示，不再当风险打分", () => {
    const r = assessShotFirstPass({ shotId: "S4", costume: "黑色粗花呢套装配珍珠耳饰及膝裙", composition: "广角全景，人物中近景占比并保持视觉主导，机身清晰可辨" });
    const ids = r.findings.map((f) => f.id);
    expect(ids).toContain("costume-design-intent");
    expect(ids).toContain("competing-subjects");
    expect(r.findings.filter((f) => f.level !== "low")).toEqual([]);   // 不进分数
    expect(r.blockers).toEqual([]);
    expect(r.ready).toBe(true);                                        // 不因创作意图被拦
  });
  it("整片：给 canary 渲染顺序（风险高的先渲），policy 版本可追溯", () => {
    const film = assessFilmFirstPass([
      { shotId: "S1", camera_movement: "固定机位", timeline: "T00:00–T00:05 稳定", composition: "中景" },
      { shotId: "S2", sceneDescription: "屏幕界面清晰可见", timeline: "T00:02 定住", camera_movement: "缓推" }
    ], { fps: 24 });
    expect(film.policy).toBe(FIRST_PASS_POLICY_VERSION);
    expect(film.ready).toBe(false);
    expect(film.renderOrder[0]).toBe("S2");
  });
});
