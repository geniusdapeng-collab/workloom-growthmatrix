/**
 * B-63 首日上岗内容包 · 随包分发用例：
 *  ① 三包都能装载，关卡顺序固定为四关、员工卡 ≥3 张、presetKey 唯一；
 *  ② 员工卡/目标卡/任务卡引用的 presetKey 必须真实存在于该 Bundle 的 presets/；
 *  ③ 员工卡 fences 文案里的规则号必须真实存在于该 Bundle 的围栏包；
 *  ④ 驳回枚举必须命中该 Bundle 的 feedback-enums.yml（未声明的包不校验 code）；
 *  ⑤ 未知 Bundle → null（不塞别行业人设）；非法包 → 装载期抛错（fail-closed）。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { QUEST_STAGE_IDS, loadQuestlinePack, questStageOf, QuestlinePackError, questlineSummary } from "./onboarding.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const BUNDLES = join(ROOT, "bundles");
const BUNDLE_IDS = ["hotel", "geo-growth", "ai-video"] as const;

const presetKeysOf = (bundleId: string): Set<string> => {
  const dir = join(BUNDLES, bundleId, "presets");
  const keys = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".yml"))) {
    const doc = YAML.parse(readFileSync(join(dir, file), "utf-8")) as { preset_key?: string };
    if (doc?.preset_key) keys.add(doc.preset_key);
  }
  return keys;
};

const fenceIdsOf = (bundleId: string): Set<string> => {
  const dir = join(BUNDLES, bundleId, "fences");
  const ids = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".yml"))) {
    const doc = YAML.parse(readFileSync(join(dir, file), "utf-8")) as { rules?: Array<{ rule_id?: string }>; fences?: Array<{ rule_id?: string }> };
    for (const rule of [...(doc.rules ?? []), ...(doc.fences ?? [])]) if (rule?.rule_id) ids.add(rule.rule_id);
  }
  return ids;
};

const feedbackCodesOf = (bundleId: string): Set<string> | null => {
  const file = join(BUNDLES, bundleId, "feedback-enums.yml");
  if (!existsSync(file)) return null;
  const doc = YAML.parse(readFileSync(file, "utf-8")) as { enums?: Array<{ code?: string }>; codes?: Array<{ code?: string }> };
  const list = doc.enums ?? doc.codes ?? [];
  return new Set(list.map((e) => String(e.code)));
};

describe("B-63 首日上岗内容包（随 Bundle 分发）", () => {
  it("三包均可装载：四关顺序固定、员工卡 ≥3、presetKey 唯一", () => {
    for (const bundleId of BUNDLE_IDS) {
      const pack = loadQuestlinePack(bundleId, BUNDLES);
      expect(pack, `${bundleId} 内容包缺失`).not.toBeNull();
      expect(pack!.bundleId).toBe(bundleId);
      expect(pack!.stages.map((s) => s.id)).toEqual([...QUEST_STAGE_IDS]);
      expect(pack!.employees.length).toBeGreaterThanOrEqual(3);
      expect(new Set(pack!.employees.map((e) => e.presetKey)).size).toBe(pack!.employees.length);
      expect(pack!.achievements.length).toBeGreaterThanOrEqual(1);
      expect(questlineSummary(pack!)).toContain(bundleId);
      // 关卡定义可按 id 取（缺关卡抛错，不静默回落）
      expect(questStageOf(pack!, "meet").badge.length).toBeGreaterThan(0);
    }
  });

  it("内容引用的岗位/围栏/驳回枚举逐条对照行业包实物（不编岗位、不编围栏）", () => {
    for (const bundleId of BUNDLE_IDS) {
      const pack = loadQuestlinePack(bundleId, BUNDLES)!;
      const presets = presetKeysOf(bundleId);
      const fences = fenceIdsOf(bundleId);
      const codes = feedbackCodesOf(bundleId);
      for (const card of pack.employees) {
        expect(presets.has(card.presetKey), `${bundleId} 员工卡 ${card.id} 引用未声明岗位 ${card.presetKey}`).toBe(true);
      }
      for (const goal of pack.goals) {
        expect(presets.has(goal.ownerPresetKey), `${bundleId} 目标卡 ${goal.id} 引用未声明岗位 ${goal.ownerPresetKey}`).toBe(true);
      }
      for (const task of pack.tasks) {
        expect(presets.has(task.ownerPresetKey), `${bundleId} 任务卡 ${task.id} 引用未声明岗位 ${task.ownerPresetKey}`).toBe(true);
      }
      for (const card of pack.employees) {
        for (const fence of card.fences) {
          // 卡片上的「航道许可」两种写法：`R21 · 规则名`（引用具体围栏，必须存在）与
          // 纯纪律描述（如「只读巡检，不改任何渠道数据」——不是围栏引用，不校验）
          const match = /^([A-Z][A-Z0-9-]*)\s*·/.exec(fence.trim());
          if (!match) continue;
          expect(fences.has(match[1]!), `${bundleId} 员工卡 ${card.id} 引用未声明围栏 ${match[1]}`).toBe(true);
        }
      }
      if (codes) {
        for (const reason of pack.rejectReasons) {
          expect(codes.has(reason.code), `${bundleId} 驳回枚举 ${reason.code} 不在 feedback-enums.yml`).toBe(true);
        }
      }
    }
  });

  it("未知 Bundle → null；内容包非法 → 装载期抛错（fail-closed）", () => {
    expect(loadQuestlinePack("unknown-industry", BUNDLES)).toBeNull();
    expect(loadQuestlinePack(null, BUNDLES)).toBeNull();
    expect(() => loadQuestlinePack("no-such-bundle", BUNDLES)).not.toThrow(); // 目录不存在 → null 而非抛错
    expect(() => questStageOf(loadQuestlinePack("hotel", BUNDLES)!, "nope" as never)).toThrow(QuestlinePackError);
  });
});
