/**
 * verify-publish-evidence.test.ts · 发布回执可核验判定回归（MC-010）
 *
 * 只测判定函数（不连库）：把「演练回执 / 无证据回执 / 回执缺失 / 正常回执」四种形态钉死。
 */
import { describe, expect, it } from "vitest";
import { evaluateReceipt } from "./verify-publish-evidence.mts";

describe("发布回执可核验判定", () => {
  it("正常回执（synced + 平台帖 ID + 时间）无问题", () => {
    const problems = evaluateReceipt({
      id: "PT-1",
      platform: "douyin",
      receipt: {
        taskId: "PT-1",
        platform: "douyin",
        platformPostId: "7400000000",
        url: "https://www.douyin.com/video/7400000000",
        evidenceUri: "rpa-evidence://douyin/abc",
        synced: true,
        verifiedAt: new Date().toISOString(),
      },
    });
    expect(problems).toEqual([]);
  });

  it("演练回执（dry-run）不得记为已发布", () => {
    const problems = evaluateReceipt({
      id: "PT-2",
      platform: "xiaohongshu",
      receipt: { taskId: "PT-2", platform: "xiaohongshu", synced: false, mode: "dry-run", driver: "dry-run" },
    });
    expect(problems.some((item) => item.includes("演练回执"))).toBe(true);
    expect(problems.some((item) => item.includes("synced"))).toBe(true);
  });

  it("只有 synced:true 而无平台证据时判为无证据", () => {
    const problems = evaluateReceipt({
      id: "PT-3",
      platform: "bilibili",
      receipt: { taskId: "PT-3", platform: "bilibili", synced: true, verifiedAt: new Date().toISOString() },
    });
    expect(problems).toEqual(["缺少平台侧证据（platformPostId / url 均为空）"]);
  });

  it("回执缺失或形态非法时判为未核实", () => {
    expect(evaluateReceipt({ id: "PT-4", platform: "youtube", receipt: null })).toEqual([
      "回执缺失或不是对象（无回执 = 未核实）",
    ]);
    expect(evaluateReceipt({ id: "PT-5", platform: "tiktok", receipt: "published" })).toEqual([
      "回执缺失或不是对象（无回执 = 未核实）",
    ]);
  });

  it("verifiedAt 非法时判为无证据（时间不可核验）", () => {
    const problems = evaluateReceipt({
      id: "PT-6",
      platform: "shipinhao",
      receipt: { taskId: "PT-6", platform: "shipinhao", url: "https://channels.weixin.qq.com/x", synced: true, verifiedAt: "昨天" },
    });
    expect(problems.some((item) => item.includes("verifiedAt"))).toBe(true);
  });
});
