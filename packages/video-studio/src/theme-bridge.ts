/** 明确Brief走原创意生成器的结构化输入接口，防止缺字段落入随机默认模板。 */
type Obj = Record<string, any>;
export interface ThemeBridgeTarget { creativeThemeGenerator: { generate(input: unknown): Promise<Obj>; llmEngine?: Obj }; requirementDiscoveryEngine?: { discover(input: Obj): Promise<Obj> } }
const obj = (value: unknown): Obj => value && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
export function installVendorThemeBridge(system: ThemeBridgeTarget, metadata: Obj): () => void {
  const generator = system.creativeThemeGenerator;
  if (!generator || typeof generator.generate !== "function") throw new Error("THEME_BRIDGE_UNAVAILABLE");
  const original = generator.generate, brief = obj(metadata.brief);
  const llm = generator.llmEngine;
  const discovery = system.requirementDiscoveryEngine, originalDiscover = discovery?.discover;
  let active = true;
  let failed = false;
  if (llm) generator.llmEngine = new Proxy(llm, { get(target, key) {
    if (key === "generate" || key === "reason") return async (prompt: string, options: Obj = {}) => {
      if (!active) throw new Error("THEME_BRIDGE_CLOSED");
      return target[key].call(target, `${prompt}\n明确Brief优先于默认题材模板：${JSON.stringify(brief)}\n本次商业产品介绍，不编造效率、效果或情节困境；主题由本次原始输入提炼，遵守完整来源与禁用政策。`,
        { ...options, forceJson: true, maxTokens: Math.max(Number(options.maxTokens) || 0, 4096), thinking: { type: "disabled" } });
    };
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  if (discovery && originalDiscover) discovery.discover = async function (input) {
    if (!active || failed) throw new Error("THEME_GENERATION_UNVERIFIED：创意生成失败，停止下游模型消耗");
    return originalDiscover.call(this, input);
  };
  generator.generate = async function (input) {
    if (!active) throw new Error("THEME_BRIDGE_CLOSED");
    const structured = typeof input === "string" ? { description: input } : structuredClone(obj(input));
    const explicit: Obj = {};
    if (obj(metadata.pipelineRoute).kind === "marketing") explicit.type = "商业广告";
    for (const [field, value] of Object.entries({ tone: brief.emotionalTone, target_audience: brief.audience,
      visual_style: brief.visualStyle, dialogue_requirement: brief.dialogueRequirement, duration_sec: brief.duration ?? brief.durationSec })) {
      if (typeof value === "string" && value.trim() || typeof value === "number" && Number.isFinite(value) && value > 0) explicit[field] = value;
    }
    let result: Obj;
    try { result = await original.call(this, { ...structured, ...explicit }); }
    catch (error) { failed = true; throw error; }
    if (!active) throw new Error("THEME_BRIDGE_CLOSED");
    if (!Array.isArray(result.tasks) || !result.tasks.length || result.tasks.some((task: Obj) => task._degraded)) {
      failed = true;
      throw new Error("THEME_GENERATION_UNVERIFIED：原创意模型失败或未返回正式任务，不能用模板替代");
    }
    return result;
  };
  return () => { if (!active) return; active = false; generator.generate = original;
    if (llm) generator.llmEngine = llm;
    if (discovery && originalDiscover) discovery.discover = originalDiscover;
  };
}
