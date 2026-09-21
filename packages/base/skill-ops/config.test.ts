import { describe, expect, it } from "vitest";
import { assertSkillDistConfig, skillDistConfigFromEnv } from "./config.js";

describe("B-56 技能保鲜环配置", () => {
  it("缺 URL/密钥 → disabled；齐备 → enabled 并读取窗口/策略", () => {
    const off = skillDistConfigFromEnv({});
    expect(off).toMatchObject({ enabled: false, autoSync: true, window: { startHour: 22, endHour: 8 }, pollMinutes: 30, policy: "silent" });
    const on = skillDistConfigFromEnv({
      SKILL_DIST_REGISTRY_URL: "https://registry.example/manifest.json",
      SKILL_DIST_SIGNING_KEY: "k",
      SKILL_DIST_POLICY: "prompt",
      SKILL_DIST_WINDOW_START: "21",
      SKILL_DIST_WINDOW_END: "7",
      SKILL_DIST_POLL_MINUTES: "15",
      SKILL_DIST_AUTO_SYNC: "0",
    });
    expect(on).toMatchObject({ enabled: true, policy: "prompt", window: { startHour: 21, endHour: 7 }, pollMinutes: 15, autoSync: false });
    expect(() => assertSkillDistConfig(on)).not.toThrow();
  });

  it("非法窗口/轮询间隔 → 拒绝；enabled 但缺件 → fail-closed", () => {
    expect(() => assertSkillDistConfig({ ...skillDistConfigFromEnv({}), window: { startHour: 24, endHour: 8 } })).toThrow(/窗口/);
    expect(() => assertSkillDistConfig({ ...skillDistConfigFromEnv({}), pollMinutes: 1 })).toThrow(/轮询间隔/);
    const broken = { ...skillDistConfigFromEnv({ SKILL_DIST_REGISTRY_URL: "https://x" }), enabled: true };
    expect(() => assertSkillDistConfig(broken)).toThrow(/fail-closed/);
  });
});
