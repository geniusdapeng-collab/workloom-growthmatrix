import { expect, it } from "vitest";
import { durationPolicy, observeFilmDuration, renderSecondsWithinCapability } from "./creative-duration-policy.js";

it.each([undefined, null, "", "creative-target"])("默认创作目标策略接受%s", input => {
  expect(durationPolicy(input)).toBe("creative-target");
});
it("严格规划必须明确选择；未知策略不能静默降级", () => {
  expect(durationPolicy("strict")).toBe("strict");
  expect(() => durationPolicy("exact-ish")).toThrow("DURATION_POLICY_INVALID");
});
it.each([28, 32, 35])("已渲染%s秒作品只观测，不变速或重新提交", seconds => {
  for (const policy of ["creative-target", "strict"] as const) {
    expect(observeFilmDuration(30, seconds, policy)).toMatchObject({ targetSeconds: 30, actualSeconds: seconds,
      driftSeconds: seconds - 30, sourceTiming: "preserved", automaticRetime: false, automaticRerender: false, durationIsAdvisory: true });
  }
});
it.each([4, 13, 30])("单镜%s秒来自模型当前能力，不沿用12秒上限", seconds => {
  expect(renderSecondsWithinCapability(seconds, { min: 4, max: 30 }, "S1")).toBe(seconds);
});
it.each([0, 2, 3.9, 4.5, 31, NaN, Infinity])("非法%s秒计划在付费提交前拒绝，不钳制", seconds => {
  expect(() => renderSecondsWithinCapability(seconds, { min: 4, max: 30 }, "S5")).toThrow("RENDER_DURATION_PLAN_INVALID");
});
it.each([{ min: 0, max: 30 }, { min: 5, max: 4 }, { min: 4, max: NaN }])("不可信能力范围%j不能授权渲染", limits => {
  expect(() => renderSecondsWithinCapability(5, limits)).toThrow("CAPABILITY_INVALID");
});
it.each([[0, 30], [30, 0], [NaN, 30], [30, Infinity]])("非法实际时长target=%s actual=%s如实失败", (target, actual) => {
  expect(() => observeFilmDuration(target, actual)).toThrow("FILM_DURATION_UNVERIFIED");
});
