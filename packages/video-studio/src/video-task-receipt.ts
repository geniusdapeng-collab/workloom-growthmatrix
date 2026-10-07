/** Paid video requests persist full identity before POST, and provider ACK before poll/download. */
import { createHash } from "node:crypto";
import path from "node:path";
import { filmCanonicalJson } from "./film-worker-channel.js";
import { GenerationFileStore } from "./generation-file-store.js";

export interface VideoTaskResult { taskId: string; url: string; lastFrame: string | null }
interface VideoIdentity { projectId: string; shotId: string; provider: string; endpoint: string; method: "POST"; body: Record<string, unknown> }
export interface VideoTaskReceipt {
  schemaVersion: "workloom.video-task-receipt/v2";
  projectId: string; shotId: string; requestSha256: string; identitySha256: string; identity: VideoIdentity;
  state: "submitting" | "submitted" | "succeeded" | "rejected";
  createdAt: string; updatedAt: string; taskId?: string; result?: VideoTaskResult; error?: string;
  origin: "submitted-here" | "legacy-resume-only";
  /** v1 did not record its endpoint. Imported task IDs permit GET only, never a new POST. */
  legacy?: Array<{ path: string; sha256: string; endpointVerified: false }>;
}
export interface VideoTaskTransport {
  submit(body: Record<string, unknown>): Promise<{ ok: boolean; status: number; text: string }>;
  poll(taskId: string): Promise<{ ok: boolean; status: number; text: string }>;
}
interface Scope {
  root: string; projectId: string; shotId: string; body: Record<string, unknown>;
  provider?: string; endpoint?: string; legacyRoots?: string[];
  /** Prior artifacts or dispatch evidence require a recoverable original receipt, never another POST. */
  requireExisting?: boolean;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const taskIdValid = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,200}$/.test(value);
const remoteUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
};
function scopeKey(input: { projectId: string; shotId: string }): string {
  if (![input.projectId, input.shotId].every(v => typeof v === "string" && v.trim())) throw new Error("VIDEO_TASK_SCOPE_INVALID");
  return hash(filmCanonicalJson({ projectId: input.projectId, shotId: input.shotId }));
}
function compiled(input: Scope): VideoIdentity {
  scopeKey(input);
  const provider = input.provider ?? "ark", endpoint = input.endpoint ?? "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks";
  if (!provider.trim() || !remoteUrl(endpoint) || !object(input.body) || typeof input.body.model !== "string" || !input.body.model.trim()) throw new Error("VIDEO_TASK_SCOPE_INVALID");
  const body = JSON.parse(filmCanonicalJson(input.body)) as Record<string, unknown>;
  const rejectSecrets = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:api[_-]?key|authorization|access[_-]?token|password|secret)$/i.test(key)) throw new Error("VIDEO_TASK_SECRET_FIELD_FORBIDDEN");
      rejectSecrets(child);
    }
  };
  rejectSecrets(body);
  return { projectId: input.projectId, shotId: input.shotId, provider, endpoint, method: "POST", body };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
export function videoTaskReceiptPath(root: string, projectId: string, shotId: string): string {
  return new GenerationFileStore(path.join(root, "v2")).path(scopeKey({ projectId, shotId }));
}
function stateFields(value: Record<string, unknown>, expected: VideoIdentity): void {
  if (value.projectId !== expected.projectId || value.shotId !== expected.shotId || value.requestSha256 !== hash(filmCanonicalJson(expected.body))
    || !["submitting", "submitted", "succeeded", "rejected"].includes(String(value.state))) throw new Error("VIDEO_TASK_RECEIPT_CHANGED: request or scope changed; no new POST");
  if (value.taskId !== undefined && !taskIdValid(value.taskId)) throw new Error("VIDEO_TASK_RECEIPT_INVALID: invalid taskId");
  if (["submitted", "succeeded"].includes(String(value.state)) && !taskIdValid(value.taskId)) throw new Error("VIDEO_TASK_RECEIPT_INVALID: missing original taskId");
  if (value.state === "succeeded" && (!object(value.result) || value.result.taskId !== value.taskId || !remoteUrl(value.result.url)
    || value.result.lastFrame !== null && !remoteUrl(value.result.lastFrame))) throw new Error("VIDEO_TASK_RECEIPT_INVALID: result not bound to taskId");
}
/** Used by read-only postproduction consumers to validate extended v2 identity. */
export function assertVideoTaskReceiptIdentity(value: unknown): void {
  if (!object(value) || value.schemaVersion !== "workloom.video-task-receipt/v2" || !object(value.identity)) throw new Error("VIDEO_TASK_RECEIPT_INVALID");
  const id = value.identity as unknown as VideoIdentity;
  const expected = compiled({ root: "", projectId: id.projectId, shotId: id.shotId, provider: id.provider, endpoint: id.endpoint, body: id.body });
  if (id.method !== "POST" || filmCanonicalJson(expected) !== filmCanonicalJson(id) || value.identitySha256 !== hash(filmCanonicalJson(id))
    || !["submitted-here", "legacy-resume-only"].includes(String(value.origin))) throw new Error("VIDEO_TASK_RECEIPT_CHANGED: identity changed");
  stateFields(value, id);
}
function current(value: unknown, expected: VideoIdentity): VideoTaskReceipt | null {
  if (value === null) return null;
  assertVideoTaskReceiptIdentity(value);
  const receipt = value as VideoTaskReceipt;
  if (filmCanonicalJson(receipt.identity) !== filmCanonicalJson(expected)) throw new Error("VIDEO_TASK_RECEIPT_CHANGED: provider, endpoint or body changed; no new POST");
  return receipt;
}
/** Read both stable v2 and explicitly supplied v1 roots. Conflicting task IDs or bodies never select a convenient record. */
export function readExistingVideoTaskReceipt(input: Scope): VideoTaskReceipt | null {
  const expected = compiled(input), key = scopeKey(input);
  const existing = current(new GenerationFileStore(path.join(input.root, "v2")).load(key), expected);
  const legacy: VideoTaskReceipt[] = [];
  for (const root of [...new Set([input.root, ...(input.legacyRoots ?? [])])]) {
    const store = new GenerationFileStore(root), value = store.load(key);
    if (value === null) continue;
    if (!object(value) || value.schemaVersion !== "workloom.video-task-receipt/v1") throw new Error("VIDEO_TASK_RECEIPT_INVALID: unrecognized legacy record");
    stateFields(value, expected);
    legacy.push({ ...value, schemaVersion: "workloom.video-task-receipt/v2", identity: expected,
      identitySha256: hash(filmCanonicalJson(expected)), origin: "legacy-resume-only",
      legacy: [{ path: store.path(key), sha256: hash(filmCanonicalJson(value)), endpointVerified: false }],
    } as VideoTaskReceipt);
  }
  const taskIds = new Set([existing, ...legacy].flatMap(value => value?.taskId ? [value.taskId] : []));
  if (taskIds.size > 1) throw new Error("VIDEO_TASK_RECEIPT_CONFLICT: multiple paid task IDs require reconciliation; no new POST");
  if (existing) {
    // A v1 acceptance may arrive after its unknown state was imported. Only this legacy origin can be supplemented.
    if (existing.origin === "legacy-resume-only" && existing.state === "submitting") {
      const acknowledged = legacy.find(value => ["submitted", "succeeded"].includes(value.state));
      if (acknowledged) return { ...acknowledged, createdAt: existing.createdAt,
        legacy: [...(existing.legacy ?? []), ...(acknowledged.legacy ?? [])] };
    }
    return existing;
  }
  const rank = { succeeded: 4, submitted: 3, rejected: 2, submitting: 1 };
  return legacy.sort((a, b) => rank[b.state] - rank[a.state])[0] ?? null;
}

/** Postproduction has no submit/poll callback. It only verifies a successful task for the same request. */
export async function verifyExistingSuccessfulVideoTask(input: Scope): Promise<{ taskId: string; requestSha256: string }> {
  const value = readExistingVideoTaskReceipt(input);
  if (value?.state !== "succeeded" || !value.taskId) throw new Error("VIDEO_TASK_SUCCESS_REQUIRED: existing successful task required");
  return { taskId: value.taskId, requestSha256: value.requestSha256 };
}

export async function resumeOrSubmitVideoTask(input: Scope & {
  transport: VideoTaskTransport; pollIntervalMs?: number; timeoutMs?: number; lockTimeoutMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<VideoTaskResult> {
  const expected = freeze(compiled(input)), key = scopeKey(input), store = new GenerationFileStore(path.join(input.root, "v2"));
  const scope = { ...input, body: expected.body, provider: expected.provider, endpoint: expected.endpoint };
  const read = () => readExistingVideoTaskReceipt(scope);
  const previous = read();
  if (previous?.state === "succeeded" && current(store.load(key), expected)?.state === "succeeded") return structuredClone(previous.result!);
  const timeout = input.timeoutMs ?? 20 * 60_000, interval = input.pollIntervalMs ?? 10_000;
  if (![timeout, interval].every(v => Number.isFinite(v) && v >= 0)) throw new Error("VIDEO_TASK_TIMEOUT_INVALID");
  return store.locked(key, { timeoutMs: input.lockTimeoutMs ?? 0, canRecover: () => Boolean(read()?.taskId) }, async () => {
    let receipt = read();
    if (receipt) store.save(key, receipt); // Freeze imported legacy evidence before any GET or refusal.
    if (receipt?.state === "succeeded") return structuredClone(receipt.result!);
    if (receipt?.state === "submitting") throw new Error("VIDEO_TASK_SUBMISSION_UNKNOWN: provider ACK not recorded; no new POST");
    if (receipt?.state === "rejected") throw new Error(`VIDEO_TASK_REJECTED: no automatic resubmission (${receipt.error ?? "unknown reason"})`);
    if (!receipt) {
      if (input.requireExisting) throw new Error("VIDEO_TASK_LEGACY_RECEIPT_REQUIRED: restore the original provider acceptance before generating");
      const at = new Date().toISOString();
      receipt = { schemaVersion: "workloom.video-task-receipt/v2", projectId: input.projectId, shotId: input.shotId,
        requestSha256: hash(filmCanonicalJson(expected.body)), identitySha256: hash(filmCanonicalJson(expected)), identity: expected,
        origin: "submitted-here", state: "submitting", createdAt: at, updatedAt: at };
      store.save(key, receipt); // Exactly one POST can follow this durable record.
      const response = await input.transport.submit(expected.body);
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) receipt.state = "rejected";
        receipt.error = `HTTP ${response.status}`; receipt.updatedAt = new Date().toISOString(); store.save(key, receipt);
        throw new Error(`视频提交失败 ${receipt.error}; no automatic resubmission`);
      }
      let submitted: { id?: unknown; data?: { id?: unknown } };
      try { submitted = JSON.parse(response.text) as typeof submitted; }
      catch { throw new Error("VIDEO_TASK_SUBMISSION_UNKNOWN: invalid ACK JSON; no new POST"); }
      const taskId = submitted?.id ?? submitted?.data?.id;
      if (!taskIdValid(taskId)) throw new Error("VIDEO_TASK_SUBMISSION_UNKNOWN: ACK has no taskId; no new POST");
      receipt.taskId = taskId; receipt.state = "submitted"; receipt.updatedAt = new Date().toISOString();
      store.save(key, receipt); // Provider task acceptance must precede all polling/download.
    }
    const taskId = receipt.taskId!, deadline = Date.now() + timeout;
    const wait = input.wait ?? (ms => new Promise(resolveWait => setTimeout(resolveWait, ms)));
    let lastError = "未收到任务状态";
    while (Date.now() < deadline) {
      await wait(Math.min(interval, Math.max(0, deadline - Date.now())));
      if (Date.now() >= deadline) break;
      let response;
      try { response = await input.transport.poll(taskId); }
      catch (error) { lastError = message(error); continue; } // GET-only recovery; never resubmit.
      if (!response.ok) { lastError = `查询HTTP ${response.status}`; continue; }
      let status: Record<string, unknown>;
      try { status = JSON.parse(response.text) as Record<string, unknown>; }
      catch { lastError = "查询返回非法JSON"; continue; }
      const state = object(status) ? String(status.status ?? "") : "";
      if (state === "succeeded" || state === "success") {
        const content = status.content as Record<string, unknown> | undefined, url = content?.video_url;
        if (!remoteUrl(url)) throw new Error(`VIDEO_TASK_RESULT_INVALID: ${taskId} has no usable video URL; no new POST`);
        const result = { taskId, url, lastFrame: remoteUrl(content?.last_frame_url) ? content.last_frame_url : null };
        receipt.result = result; receipt.state = "succeeded"; receipt.updatedAt = new Date().toISOString(); store.save(key, receipt); return result;
      }
      if (["failed", "cancelled", "canceled"].includes(state)) {
        receipt.state = "rejected"; receipt.error = `任务${state}`; receipt.updatedAt = new Date().toISOString(); store.save(key, receipt);
        throw new Error(`渲染任务 ${receipt.error}`);
      }
      lastError = `任务${taskId}状态${state || "缺失"}`;
    }
    throw new Error(`视频轮询超时（taskId=${taskId}，恢复只查此任务）：${lastError}`);
  });
}
