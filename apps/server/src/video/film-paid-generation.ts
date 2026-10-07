/** Paid acceptance is durable before polling/downloading; a recovery never submits again. */
import type { GenProvider, GenRequest } from "@workloom/base/model-router";
import { canonicalRenderJson, compileProviderRequest, renderSha256, type CompiledProviderRequest, type ProviderEndpointOptions } from "./gen/compiled-request.js";
import { SubmissionError } from "./gen/submission-ledger.js";
import type { FilmLedger } from "./film-ledger.js";

export interface FilmPaidRequestIdentity {
  schemaVersion: "workloom.film-paid-request/v1";
  provider: string;
  providerModel: string;
  endpoint: string;
  method: "POST";
  payloadHash: string;
}

export function filmPaidRequestIdentity(compiled: CompiledProviderRequest): FilmPaidRequestIdentity {
  const identity = { provider: compiled.provider, providerModel: compiled.providerModel, endpoint: compiled.endpoint,
    method: compiled.method, body: compiled.body };
  if (compiled.schemaVersion !== "workloom.provider-request/v1" || compiled.method !== "POST"
    || canonicalRenderJson(compiled.body) !== compiled.bodyJson
    || renderSha256(canonicalRenderJson(identity)) !== compiled.payloadHash) {
    throw new SubmissionError("PAID_REQUEST_UNVERIFIED", "完整供应商请求与摘要不一致，未发起生成");
  }
  const result = { schemaVersion: "workloom.film-paid-request/v1" as const,
    provider: compiled.provider, providerModel: compiled.providerModel, endpoint: compiled.endpoint,
    method: compiled.method, payloadHash: compiled.payloadHash };
  validateFilmPaidIdentity(result);
  return result;
}

export function validateFilmPaidIdentity(value: FilmPaidRequestIdentity): void {
  const target = new URL(value.endpoint);
  if (value.schemaVersion !== "workloom.film-paid-request/v1" || !value.provider?.trim() || !value.providerModel?.trim()
    || value.method !== "POST" || !/^[a-f0-9]{64}$/.test(value.payloadHash)
    || !["http:", "https:"].includes(target.protocol) || target.username || target.password || target.hash) {
    throw new SubmissionError("PAID_REQUEST_UNVERIFIED", "供应商完整请求身份非法");
  }
}

/** The transport recompiles immediately from a private clone; it must send the frozen bytes. */
export async function submitBoundFilmRequest(options: {
  compiled: CompiledProviderRequest;
  request: GenRequest;
  endpoint: ProviderEndpointOptions;
  provider: Pick<GenProvider, "submit">;
}): Promise<{ taskId: string }> {
  filmPaidRequestIdentity(options.compiled);
  const request = structuredClone(options.request);
  const actual = compileProviderRequest(options.compiled.provider, request, options.endpoint);
  if (actual.payloadHash !== options.compiled.payloadHash || actual.bodyJson !== options.compiled.bodyJson) {
    throw new SubmissionError("PAID_REQUEST_CHANGED", "受理记账后供应商请求发生变化，未再次提交");
  }
  return options.provider.submit(request);
}

/** A response replay is successful only while its actual, unchanged artifact still exists. */
export async function replayFilmPaidResult(options: {
  evidence: Record<string, unknown>;
  readArtifact: (ref: string) => Promise<Buffer>;
}): Promise<Record<string, unknown>> {
  const result = options.evidence.result;
  if (!result || typeof result !== "object" || Array.isArray(result)
    || typeof options.evidence.resultSha256 !== "string"
    || renderSha256(canonicalRenderJson(result)) !== options.evidence.resultSha256) {
    throw new SubmissionError("PAID_RESULT_RECOVERY_REQUIRED", "已有受理回执但缺少完整产物响应；可恢复原任务，禁止重新付费提交");
  }
  const replay = structuredClone(result) as Record<string, unknown>;
  if (typeof replay.ref !== "string" || typeof replay.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(replay.sha256)
    || !Number.isSafeInteger(replay.bytes) || Number(replay.bytes) <= 0
    || replay.sha256 !== options.evidence.artifactSha256 || replay.ref !== options.evidence.artifactRef
    || replay.bytes !== options.evidence.artifactBytes) {
    throw new SubmissionError("PAID_RESULT_UNVERIFIED", "已有产物回执不一致，禁止重复提交");
  }
  const bytes = await options.readArtifact(replay.ref);
  if (renderSha256(bytes) !== replay.sha256 || bytes.byteLength !== replay.bytes) {
    throw new SubmissionError("PAID_RESULT_UNVERIFIED", "已有产物字节与受理回执不一致，禁止重复提交");
  }
  return replay;
}

export interface FilmPaidTask {
  taskId: string;
  reused: boolean;
  sourceComponentId: string;
}

/** One submit, followed by immediate ACK persistence. No paid retry on any exception. */
export async function obtainFilmPaidTask(options: {
  ledger: Pick<FilmLedger, "beginPaidDispatch" | "recordProviderTaskAccepted">;
  componentId: string;
  ownerToken: string;
  compiled: CompiledProviderRequest;
  signal: AbortSignal;
  submit: (compiled: CompiledProviderRequest) => Promise<{ taskId: string }>;
}): Promise<FilmPaidTask> {
  options.signal.throwIfAborted();
  const frozen = structuredClone(options.compiled);
  const identity = filmPaidRequestIdentity(frozen);
  const decision = await options.ledger.beginPaidDispatch(options.componentId, options.ownerToken, identity);
  if (decision.mode === "reuse") return { taskId: decision.taskId,
    reused: decision.sourceComponentId !== options.componentId, sourceComponentId: decision.sourceComponentId };
  options.signal.throwIfAborted();
  const accepted = await options.submit(frozen);
  if (typeof accepted?.taskId !== "string" || !accepted.taskId.trim() || accepted.taskId.length > 65_536) {
    throw new SubmissionError("PROVIDER_ACK_UNKNOWN", "生成响应缺少可核验任务号；禁止自动重新提交");
  }
  // Even a late response after abort preserves its ACK; the ledger keeps the existing state.
  await options.ledger.recordProviderTaskAccepted(options.componentId, options.ownerToken, identity, accepted.taskId);
  options.signal.throwIfAborted();
  return { taskId: accepted.taskId, reused: false, sourceComponentId: options.componentId };
}
