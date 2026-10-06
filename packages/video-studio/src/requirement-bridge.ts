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

/** Validate actual scene-agent JSON before vendor can substitute copied examples as content. */
function sceneContractIssue(value: unknown, targetDuration?: number): string | null {
  try {
    const scene = object(value, "sceneStructure");
    for (const { label, data } of nodes({ sceneStructure: scene })) {
      const purpose = text(data.purpose);
      if (!purpose || /^(开场目的|场景目的|结尾目的)\s*[—-]/.test(purpose)) return `${label}.purpose仍是模板问句，必须回答实际画面、作用和观众感受`;
      for (const field of ["props", "actions"] as const) {
        const items = data[field];
        if (!Array.isArray(items) || !items.length || items.some((item) => !text(item))) return `${label}.${field}必须包含本次生成的非空字符串，不能用purpose或keyElements充数`;
      }
      if (!Number.isFinite(Number(data.duration)) || Number(data.duration) <= 0) return `${label}.duration必须为正数`;
    }
    const total = nodes({ sceneStructure: scene }).reduce((sum, node) => sum + Number(node.data.duration), 0);
    if (Number.isFinite(targetDuration) && Math.abs(total - targetDuration!) > .05) return `实际场景时长合计${total}s，必须由模型重新分配到明确目标${targetDuration}s；不能复制10秒示例`;
    if (Math.abs(total - Number(scene.totalDuration)) > .05) return `totalDuration=${String(scene.totalDuration)}与实际场景总和${total}s不一致`;
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const SCENE_CONTRACT = `\n\n【宿主场景字段契约】
继续使用上面的开场、主体和结尾结构与本次原始故事。范例中的“开场目的/场景目的/结尾目的 —— …”是问题说明，禁止原样复制；purpose必须写本次场景实际承担的叙事作用与观众感受。
每个opening/scenes[i]/ending增加props:string[]（仅可见的实体名称，禁止动作、构图、效果句）及actions:string[]（角色或摄影机的实际动作，禁止目的问句）。keyElements继续按原格式输出，不可替代props/actions。
只使用原始意图允许宣传的商品特征。原始意图禁止的宣称优先于历史摘要卡候选；档案记录不代表本片允许口播或演示。没有竞品证据时，摘要中的“差异化空位/竞品没讲的”仅代表档案特征，不得输出比较优势。
机身结构、可动部件与产品操作不能凭想象新增；不把可选配置写成未获支持的机械变形或现场切换。所有字段必须来自本次模型实际创作，不能留模板、占位符或元问题。`;

/** Show only actual structured source values; no regex extraction from arbitrary request sentences. */
export function renderStructuredRequirementContract(metadata: Recordish, list: Recordish, discovery: Recordish): string {
  const scenes = nodes(discovery);
  const characters = Array.isArray(list.characters) ? list.characters.map((value) => object(value, "character")) : [];
  const brief = metadata.brief ? object(metadata.brief, "brief") : {};
  const props = [...new Set([text(brief.product), ...scenes.flatMap(({ data }) => strings(data.props))].filter(Boolean))];
  const actions = scenes.flatMap(({ label, data }) => strings(data.actions).map((action) => `${label}：${action}`));
  const line = (label: string, items: string[]): string => `- **${label}**（${items.length}）：${items.length ? items.join("；") : "未提取到，须由本次审核判断"}`;
  const constraints = strings(list.contentConstraints);
  return `\n\n---\n\n## 四、需求契约（结构化生成物与明确角色档案）\n\n${[
    line("角色", characters.map((c) => `${text(c.name)}（${text(c.role)}，id=${text(c.id)}）${text(c.assetRef) ? `，平台引用=${text(c.assetRef)}` : ""}；档案=${text(c.description)}`)),
    line("场景", scenes.map(({ label, data }) => `${label}（${Number(data.duration)}s）：${text(data.purpose)}`)),
    line("道具", props),
    line("动作", actions),
  ].join("\n")}\n\n- 业务约束：${constraints.length ? constraints.join("；") : "未提取到"}\n- 口径：${Number(list.targetDuration)}s / ${text(brief.aspectRatio) || text(list.aspectRatio)} / ${text(brief.platform) || text(list.platform)}\n- 来源：角色来自明确请求档案；场景、道具、动作分别来自本次模型的purpose、props、actions字段，不猜测截断词，不把动作句充作道具。批准仍由原有G3审核作出。\n- 事实与使用边界：档案原文记录不等于本片使用许可；原始意图禁用项不得进入画面或口播。缺少竞品证据时，上游历史摘要中的“差异化空位（竞品没讲的）”仅作登记特征参考，不构成比较事实。创作场景、灯光与动作是待审核方案，不宣称已核实为真实拍摄记录。\n`;
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
  const brief = metadata.brief ? object(metadata.brief, "brief") : {};
  const targetDuration = Number(brief.duration ?? brief.durationSec);
  const sceneAgent = engine.agents?.scene;
  const sceneLLM = sceneAgent?.llmEngine;
  let active = true;
  let sceneFeedback = "";
  if (sceneAgent && sceneLLM && typeof sceneLLM.reason === "function") {
    sceneAgent.llmEngine = new Proxy(sceneLLM, {
      get(target, key) {
        if (key === "reason") return async (prompt: unknown, options: Recordish = {}) => {
          if (!active) throw new Error("REQUIREMENT_BRIDGE_CLOSED");
          // The vendor's shape example repeats 10s in every node and says two nodes
          // while also requiring a middle array. Those sample values are not a plan.
          // Remove only example defaults; actual allocation stays with SceneArchitect.
          const shapePrompt = String(prompt).replace(/"duration"\s*:\s*10(?=\s*[,}])/g, '"duration":null');
          const augmented = `${shapePrompt}${SCENE_CONTRACT}\n明确角色档案：${JSON.stringify(cast)}\n明确时长：${Number.isFinite(targetDuration) ? `${targetDuration}秒；所有opening+scenes+ending的duration相加必须等于该值` : "按上游目标时长，totalDuration必须等于各场景实际总和"}\n时长分配口径：示例的null仅表示待模型分配，不是合法输出。先按本次叙事自行确定主体场景数量和opening/ending时长，再将目标总时长减去opening.duration和ending.duration，剩余秒数分给scenes；返回前按实际数组逐项加总。不得将主体场景总和当作整片总和，也不得每增加一场就复制旧10秒。sceneCount为opening、scenes所有元素、ending的合计数量；示例计数不约束本次真实数量。每个duration最终必须是正数，totalDuration最终必须等于逐项加总与明确目标。\n独立登记资产核验：${JSON.stringify(metadata.referenceAssets ?? null)}\n只使用明确人物，不新增经营者、客人或未登记的单屏参考图片。${sceneFeedback ? `\n上次实际字段错误：${sceneFeedback}；请针对错误重新生成，不复制旧输出。` : ""}`;
          const result = await (target.reason as (p: unknown, o: Recordish) => unknown).call(target, augmented, { ...options, forceJson: true, thinking: { type: "disabled" } });
          if (!active) throw new Error("REQUIREMENT_BRIDGE_CLOSED");
          if (result && typeof result === "object" && (result as Recordish).success === true) {
            let parsed: unknown;
            try { parsed = JSON.parse(String((result as Recordish).content)); }
            catch { throw new Error("REQUIREMENT_SCENE_INVALID: 场景结果不是JSON"); }
            const issue = sceneContractIssue(parsed, targetDuration);
            if (issue) { sceneFeedback = issue; throw new Error(`REQUIREMENT_SCENE_INVALID: ${issue}`); }
            sceneFeedback = "";
          }
          return result;
        };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  engine.discover = async function awaitedDiscovery(upstream) {
    if (!active) throw new Error("REQUIREMENT_BRIDGE_CLOSED");
    const discovery = object(await originalDiscover.call(this, upstream), "discovery");
    const issue = sceneContractIssue(discovery.sceneStructure, targetDuration);
    if (issue) throw new Error(`REQUIREMENT_SCENE_INVALID: ${issue}`);
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
