/**
 * skill-ops/config —— 技能保鲜环运行配置（B-56）
 *
 * 唯一配置源：registry URL + 签名密钥 + 自动同步策略与夜班窗口。
 * 纪律：enabled 时必须同时具备 URL 与签名密钥（缺一即 fail-closed，不降级跳验签）。
 */

export interface SkillDistConfig {
  enabled: boolean;
  registryUrl: string;
  /** 签名密钥（只来自环境/秘密存储，不落文件） */
  signingKey: string;
  autoSync: boolean;
  /** 夜班同步窗口（本地小时，支持跨午夜，如 22 → 8） */
  window: { startHour: number; endHour: number };
  pollMinutes: number;
  policy: "silent" | "prompt";
}

export function skillDistConfigFromEnv(env: Record<string, string | undefined> = process.env): SkillDistConfig {
  const registryUrl = env.SKILL_DIST_REGISTRY_URL?.trim() ?? "";
  const signingKey = env.SKILL_DIST_SIGNING_KEY?.trim() ?? "";
  const startHour = Number(env.SKILL_DIST_WINDOW_START ?? 22);
  const endHour = Number(env.SKILL_DIST_WINDOW_END ?? 8);
  const pollMinutes = Number(env.SKILL_DIST_POLL_MINUTES ?? 30);
  const policy = env.SKILL_DIST_POLICY === "prompt" ? "prompt" : "silent";
  const autoSync = env.SKILL_DIST_AUTO_SYNC !== "0";
  return {
    enabled: Boolean(registryUrl && signingKey),
    registryUrl,
    signingKey,
    autoSync,
    window: { startHour, endHour },
    pollMinutes,
    policy,
  };
}

export function assertSkillDistConfig(config: SkillDistConfig): void {
  for (const [key, value] of [["startHour", config.window.startHour], ["endHour", config.window.endHour]] as const) {
    if (!Number.isInteger(value) || value < 0 || value > 23) throw new Error(`保鲜环窗口 ${key} 非法：${value}`);
  }
  if (!Number.isInteger(config.pollMinutes) || config.pollMinutes < 5 || config.pollMinutes > 24 * 60) {
    throw new Error(`保鲜环轮询间隔非法：${config.pollMinutes}（5–1440 分钟）`);
  }
  if (config.enabled && (!config.registryUrl || !config.signingKey)) {
    throw new Error("保鲜环已启用但缺 registry URL 或签名密钥（fail-closed，不跳验签）");
  }
}
