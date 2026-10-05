/** Instance bridge for vendor create's unawaited requirement conversion. Vendor sources stay read-only. */
type Recordish = Record<string, unknown>;
interface DiscoveryEngine {
  discover(input: Recordish): Promise<Recordish>;
  agents?: { scene?: { llmEngine?: Recordish } };
}
export interface RequirementBridgeTarget {
  requirementDiscoveryEngine: DiscoveryEngine;
  _convertDiscoveryToRequirementList(discovery: Recordish, upstream: Recordish): Recordish | Promise<Recordish>;
  _renderRequirementContract(intent: string, metadata: Recordish, list: Recordish, discovery: Recordish): string;
}

function object(value: unknown, label: string): Recordish {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`REQUIREMENT_BRIDGE_INVALID: ${label}`);
  return value as Recordish;
}
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const strings = (value: unknown): string[] => Array.isArray(value) ? value.map(text).filter(Boolean) : [];

function requestedCharacters(metadata: Recordish): Recordish[] {
  if (metadata.characters !== undefined) {
    if (!Array.isArray(metadata.characters)) throw new Error("REQUIREMENT_CHARACTERS_INVALID: characters必须为数组");
    return metadata.characters.map((value) => {
      const item = object(value, "character");
      if (!text(item.name)) throw new Error("REQUIREMENT_CHARACTERS_INVALID: 角色缺少明确name");
      return structuredClone(item);
    });
  }
  if (!metadata.characterArchive) return [];
  const archive = object(metadata.characterArchive, "characterArchive");
  if (!text(archive.id) || !text(archive.name)) throw new Error("REQUIREMENT_CHARACTERS_INVALID: 档案缺少id/name");
  const authorization = archive.authorization ? object(archive.authorization, "authorization") : undefined;
  return [{
    id: archive.id, name: archive.name, role: "protagonist",
    description: JSON.stringify({ identity: archive.identity, appearance: archive.appearance, wardrobe: archive.wardrobe, persona: archive.persona }),
    ...(authorization ? { assetRef: authorization.evidence } : {}),
    source: "requested-character-archive",
  }];
}

function nodes(discovery: Recordish): Array<{ label: string; data: Recordish }> {
  const scene = object(discovery.sceneStructure, "sceneStructure");
  if (!Array.isArray(scene.scenes)) throw new Error("REQUIREMENT_BRIDGE_INVALID: sceneStructure.scenes");
  return [
    { label: "开场", data: object(scene.opening, "opening") },
    ...scene.scenes.map((node, i) => ({ label: `主体场景${i + 1}`, data: object(node, "scene") })),
    { label: "结尾", data: object(scene.ending, "ending") },
  ];
}

/** Show only actual structured source values; no regex extraction from arbitrary request sentences. */
export function renderStructuredRequirementContract(metadata: Recordish, list: Recordish, discovery: Recordish): string {
  const scenes = nodes(discovery);
  const characters = Array.isArray(list.characters) ? list.characters.map((value) => object(value, "character")) : [];
  const brief = metadata.brief ? object(metadata.brief, "brief") : {};
  const props = [...new Set([text(brief.product), ...scenes.flatMap(({ data }) => strings(data.keyElements))].filter(Boolean))];
  const actions = scenes.map(({ label, data }) => `${label}：${text(data.purpose)}`).filter((item) => !item.endsWith("："));
  const line = (label: string, items: string[]): string => `- **${label}**（${items.length}）：${items.length ? items.join("；") : "未提取到，须由本次审核判断"}`;
  const constraints = strings(list.contentConstraints);
  return `\n\n---\n\n## 四、需求契约（结构化生成物与明确角色档案）\n\n${[
    line("角色", characters.map((c) => `${text(c.name)}（${text(c.role)}，id=${text(c.id)}）${text(c.assetRef) ? `，平台引用=${text(c.assetRef)}` : ""}；档案=${text(c.description)}`)),
    line("场景", scenes.map(({ label, data }) => `${label}（${Number(data.duration)}s）：${text(data.purpose)}`)),
    line("道具", props),
    line("动作", actions),
  ].join("\n")}\n\n- 业务约束：${constraints.length ? constraints.join("；") : "未提取到"}\n- 口径：${Number(list.targetDuration)}s / ${text(brief.aspectRatio) || text(list.aspectRatio)} / ${text(brief.platform) || text(list.platform)}\n- 来源：角色来自明确请求档案，场景、实物元素和行为来自本次洞察生成物；动作逐场保留完整目的，不猜测截断词。批准仍由原有G3审核作出。\n`;
}

export function installVendorRequirementBridge(
  system: RequirementBridgeTarget,
  metadata: Recordish,
  log: (line: string) => void = () => undefined,
): () => void {
  const engine = system.requirementDiscoveryEngine;
  if (!engine || typeof engine.discover !== "function" || typeof system._convertDiscoveryToRequirementList !== "function"
    || typeof system._renderRequirementContract !== "function") throw new Error("REQUIREMENT_BRIDGE_UNAVAILABLE");
  const originalDiscover = engine.discover;
  const originalConvert = system._convertDiscoveryToRequirementList;
  const originalRender = system._renderRequirementContract;
  const cache = new WeakMap<Recordish, Recordish>();
  const cast = requestedCharacters(metadata);
  const sceneAgent = engine.agents?.scene;
  const sceneLLM = sceneAgent?.llmEngine;
  let active = true;
  if (sceneAgent && sceneLLM && typeof sceneLLM.reason === "function") {
    sceneAgent.llmEngine = new Proxy(sceneLLM, {
      get(target, key) {
        if (key === "reason") return (prompt: unknown, options: Recordish = {}) =>
          (target.reason as (p: unknown, o: Recordish) => unknown).call(target, prompt, { ...options, forceJson: true, thinking: { type: "disabled" } });
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  engine.discover = async function awaitedDiscovery(upstream) {
    if (!active) throw new Error("REQUIREMENT_BRIDGE_CLOSED");
    const discovery = object(await originalDiscover.call(this, upstream), "discovery");
    const list = object(await originalConvert.call(system, discovery, upstream), "requirementList");
    if (!active) throw new Error("REQUIREMENT_BRIDGE_CLOSED");
    if (cast.length || metadata.characters !== undefined) list.characters = structuredClone(cast);
    const scene = object(discovery.sceneStructure, "sceneStructure");
    const actualCount = nodes(discovery).length;
    const priorCount = scene.sceneCount;
    scene.sceneCount = actualCount;
    discovery._workloomRequirementBridge = { conversion: "awaited-vendor-converter", castSource: cast.length ? "explicit-request" : "vendor", priorSceneCount: priorCount, sceneCount: actualCount };
    cache.set(discovery, list);
    log(`[requirement-bridge] 完整转换已等待；明确角色${cast.length}；结构场景${actualCount}（原计数${String(priorCount)}）`);
    return discovery;
  };
  system._convertDiscoveryToRequirementList = (discovery) => {
    const list = active && cache.get(discovery);
    if (!list) throw new Error("REQUIREMENT_CONVERSION_NOT_READY: 禁止把未等待Promise交给审核");
    return list;
  };
  system._renderRequirementContract = (_intent, currentMetadata, list, discovery) => {
    if (!active || cache.get(discovery) !== list) throw new Error("REQUIREMENT_CONVERSION_NOT_READY");
    return renderStructuredRequirementContract(currentMetadata, list, discovery);
  };
  return () => {
    if (!active) return;
    active = false;
    engine.discover = originalDiscover;
    system._convertDiscoveryToRequirementList = originalConvert;
    system._renderRequirementContract = originalRender;
    if (sceneAgent && sceneLLM) sceneAgent.llmEngine = sceneLLM;
  };
}
