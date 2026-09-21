/**
 * B-81 降级路径测试：HTML/CSS 出图、显式标注、人工发布挂起、确定性。
 */
import { describe, expect, it } from "vitest";
import { buildDegradedPoster, planDegradedContent } from "./degrade.js";

const spec = {
  id: "poster-1", title: "秋季保养限时 8 折", subtitle: "到店出示本文即可", brand: "瑞刻激光",
  width: 1080, height: 1440, theme: "light" as const,
};

describe("B-81 降级出图", () => {
  it("HTML 含 mode=degraded 注释、data 标注与可见角标「降级产出」", () => {
    const asset = buildDegradedPoster(spec);
    expect(asset).toMatchObject({ label: "降级产出", mode: "degraded", manualPublishRequired: true });
    expect(asset.html).toContain("<!-- workloom:mode=degraded manual_publish=required -->");
    expect(asset.html).toContain('data-workloom-mode="degraded"');
    expect(asset.html).toContain('data-manual-publish="required"');
    expect(asset.html).toContain("降级产出 · 待人工确认");
    expect(asset.html).toContain("1080px");
    expect(asset.html).toContain("1440px");
  });

  it("HTML 转义用户文案，避免注入", () => {
    const asset = buildDegradedPoster({ ...spec, title: "<script>alert(1)</script>" });
    expect(asset.html).not.toContain("<script>alert(1)</script>");
    expect(asset.html).toContain("&lt;script&gt;");
  });

  it("确定性：同输入同输出（可黄金文件比对）", () => {
    expect(buildDegradedPoster(spec).html).toBe(buildDegradedPoster(spec).html);
  });

  it("降级计划：发布挂起 manual_hold + 标签齐全", () => {
    const plan = planDegradedContent({ reason: "no-bridge", specs: [spec, { ...spec, id: "poster-2" }] });
    expect(plan.mode).toBe("degraded");
    expect(plan.assets).toHaveLength(2);
    expect(plan.publish.status).toBe("manual_hold");
    expect(plan.publish.note).toContain("人工确认后手动发布");
    expect(plan.labels).toEqual(["降级产出", "manual_hold", "degrade:no-bridge"]);
    expect(() => planDegradedContent({ reason: "no-bridge", specs: [] })).toThrow(/至少需要 1 张海报/);
  });
});
