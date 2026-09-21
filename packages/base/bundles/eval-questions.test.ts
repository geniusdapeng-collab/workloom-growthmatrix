/**
 * B-43 行业包考试题集门禁：hotel / ai-video / geo-growth 都必须能通过
 * 「清单声明 → 摘要校验 → 题集 Schema」全链装载，题量、红线题与题号唯一性达标。
 *
 * 背景：考试院 resolveEvalQuestionSet 只认活动 Bundle 声明的题集；未声明的包
 * 直接 fail-closed 拒绝开考（岗位升级先过考因此无从谈起）。
 */
import { describe, expect, it } from "vitest";
import { bundleEvalQuestionId, loadVerifiedBundleEvalQuestions } from "./eval-questions.js";

const REQUIRED: Record<string, number> = {
  hotel: 20,
  "ai-video": 20,
  "geo-growth": 1,
};

describe("B-43 行业包考试题集装载门禁", () => {
  for (const [bundleId, minQuestions] of Object.entries(REQUIRED)) {
    it(`${bundleId}：题集可验证装载且不少于 ${minQuestions} 题`, () => {
      const set = loadVerifiedBundleEvalQuestions(bundleId);
      expect(set.bundleId).toBe(bundleId);
      expect(set.questions.length).toBeGreaterThanOrEqual(minQuestions);
    });

    it(`${bundleId}：题号确定性唯一、每题至少一条断言`, () => {
      const set = loadVerifiedBundleEvalQuestions(bundleId);
      const ids = set.questions.map((q, index) => bundleEvalQuestionId("ws-eval-gate", bundleId, index, q));
      expect(new Set(ids).size).toBe(ids.length);
      expect(set.questions.every((q) => q.assertions.length > 0)).toBe(true);
      expect(set.questions.every((q) => q.tags.length > 0)).toBe(true);
    });

    it(`${bundleId}：红线题在场（不通过一票否决语义可考）`, () => {
      const set = loadVerifiedBundleEvalQuestions(bundleId);
      expect(set.questions.some((q) => q.redLine)).toBe(true);
    });
  }
});
