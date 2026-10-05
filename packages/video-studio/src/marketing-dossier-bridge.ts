/** 正式G1受审装订快照的作用域消费桥；vendor仍只读。 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { filmCanonicalJson } from "./film-worker-channel.js";

type JsonObject = Record<string, unknown>;
export interface ReviewedMarketingDossier {
  projectId: string; assemblyJson: string; sha256: string; rawSha256: string; productQuery: JsonObject;
}
interface Scope { active: boolean; consumed: boolean; proof: ReviewedMarketingDossier; assembly: JsonObject }
interface EnginePrototype { assemble(trace: string, input: JsonObject, raw: JsonObject): JsonObject }
export interface MarketingDossierTarget { _buildThemeInput(intent: string, metadata: JsonObject): unknown }
const context = new AsyncLocalStorage<Scope>();
const installed = new WeakSet<EnginePrototype>();
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");

export function validateReviewedMarketingDossier(proof: ReviewedMarketingDossier, projectId: string, rawSha256: string): JsonObject {
  if (!proof || proof.projectId !== projectId || proof.rawSha256 !== rawSha256
    || !/^[a-f0-9]{64}$/.test(proof.sha256) || hash(proof.assemblyJson) !== proof.sha256) {
    throw new Error("MARKETING_G1_REQUIRED：完整受审档案未绑定本项目与事实回填");
  }
  const assembly = JSON.parse(proof.assemblyJson) as JsonObject;
  if (!assembly || assembly.ok !== true || (assembly.chain as JsonObject)?.ok !== true
    || !assembly.dossier || !assembly.cards || !Array.isArray(assembly.envelopes) || assembly.envelopes.length !== 5) {
    throw new Error("MARKETING_G1_REQUIRED：完整受审档案没有真实五站完成结构");
  }
  return assembly;
}

/** 与确认分发器相同：只装一次的固定dispatcher，非作用域调用仍执行原方法；关闭作用域拒绝晚到调用。 */
function installDispatcher(prototype: EnginePrototype): void {
  if (installed.has(prototype)) return;
  const original = prototype.assemble;
  prototype.assemble = function (trace, input, raw) {
    const scope = context.getStore();
    if (!scope) return original.call(this, trace, input, raw);
    if (!scope.active) throw new Error("MARKETING_DOSSIER_CLOSED：已结束作用域禁止重用档案");
    if (filmCanonicalJson(input) !== filmCanonicalJson(scope.proof.productQuery)
      || hash(filmCanonicalJson(raw)) !== scope.proof.rawSha256) {
      throw new Error("MARKETING_DOSSIER_CHANGED：创作输入与G1完整审核对象不同");
    }
    scope.consumed = true;
    return structuredClone(scope.assembly);
  };
  installed.add(prototype);
}

export async function runWithReviewedMarketingDossier<T>(input: {
  proof: ReviewedMarketingDossier; projectId: string; rawSha256: string; system: MarketingDossierTarget;
  /** 测试只替换vendor类型，不替换作用域、摘要或输入校验。 */
  prototype?: EnginePrototype;
}, execute: () => Promise<T>): Promise<T> {
  const assembly = validateReviewedMarketingDossier(input.proof, input.projectId, input.rawSha256);
  const prototype = input.prototype ?? (createRequire(import.meta.url)(
    new URL("../../../vendor/supermickey/hyperreality-system/engines/data-mining-engine/index.js", import.meta.url).pathname
  ) as { JennyLoomEngine: { prototype: EnginePrototype } }).JennyLoomEngine.prototype;
  installDispatcher(prototype);
  const scope: Scope = { active: true, consumed: false, proof: structuredClone(input.proof), assembly };
  const originalTheme = input.system._buildThemeInput;
  if (typeof originalTheme !== "function") throw new Error("MARKETING_DOSSIER_CONSUMER_MISSING：正式主题入口缺失");
  input.system._buildThemeInput = function (intent, metadata) {
    // vendor会捕获情报异常继续；必须在主题生成前停止，confirmation字样使其走原有流程失败出口。
    if (!scope.active || !scope.consumed) throw new Error("marketing confirmation：受审档案尚未被正式消费，禁止进入创意");
    return originalTheme.call(this, intent, metadata);
  };
  return context.run(scope, async () => {
    try {
      const result = await execute();
      if (!scope.consumed) throw new Error("MARKETING_DOSSIER_NOT_CONSUMED：创作未消费受审档案");
      return result;
    } finally {
      scope.active = false;
      input.system._buildThemeInput = originalTheme;
    }
  });
}
