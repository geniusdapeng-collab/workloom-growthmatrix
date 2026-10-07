/** Product objective: deliver a complete film, preserve rendered performances, observe total duration. */
export const CREATIVE_DURATION_POLICY_VERSION = "workloom.creative-duration/v1";
export type DurationPolicy = "creative-target" | "strict";

export function durationPolicy(value: unknown = "creative-target"): DurationPolicy {
  if (value === undefined || value === null || value === "") return "creative-target";
  if (value !== "creative-target" && value !== "strict") throw new Error("DURATION_POLICY_INVALID: creative-target or strict required");
  return value;
}

export const FILM_COMPLETENESS_PRINCIPLE = "给客户交付高完成度作品是最高创作目标。整体秒数默认是目标而非硬闸：目标30秒可以自然落在28、32、35秒等。优先完整表达、自然表演、连贯剪辑、清晰对白和获客引导；不要为凑秒数增加无用镜头、切断动作或口播。规划前核对模型单镜时长能力；渲染后完整保留原始时长与速度，不自动拉长、裁短、冻结或变速，不因总时长漂移重新付费渲染。独立封面/结尾卡承担标题与行动引导，不重复堆字。";

export function renderSecondsWithinCapability(seconds: number, limits: { min: number; max: number }, shotId = "shot"): number {
  if (!Number.isFinite(limits.min) || !Number.isFinite(limits.max) || limits.min <= 0 || limits.max < limits.min) {
    throw new Error("RENDER_DURATION_CAPABILITY_INVALID");
  }
  if (!Number.isFinite(seconds) || !Number.isInteger(seconds) || seconds < limits.min || seconds > limits.max) {
    throw new Error(`RENDER_DURATION_PLAN_INVALID: ${shotId}=${seconds}s; plan an integer within ${limits.min}–${limits.max}s before paid submission; no clamping or later retiming`);
  }
  return seconds;
}

/** Strictness belongs to the plan. A completed render never earns another POST or a time stretch from this observation. */
export function observeFilmDuration(targetSeconds: number, actualSeconds: number, policy: DurationPolicy = "creative-target") {
  durationPolicy(policy);
  if (!Number.isFinite(targetSeconds) || targetSeconds <= 0 || !Number.isFinite(actualSeconds) || actualSeconds <= 0) {
    throw new Error("FILM_DURATION_UNVERIFIED: finite positive target and actual duration required");
  }
  return { policyVersion: CREATIVE_DURATION_POLICY_VERSION, policy, targetSeconds, actualSeconds,
    driftSeconds: Number((actualSeconds - targetSeconds).toFixed(6)), sourceTiming: "preserved" as const,
    automaticRetime: false, automaticRerender: false, durationIsAdvisory: true };
}
