/** Synchronous paid image acceptance is saved before any caller downloads the result. */
import { createHash } from "node:crypto";
import { filmCanonicalJson } from "./film-worker-channel.js";
import { GenerationFileStore } from "./generation-file-store.js";

export interface ImageTaskResult { url: string; size?: string }
interface ImageIdentity { projectId: string; slotId: string; provider: string; endpoint: string; method: "POST"; body: Record<string, unknown> }
interface ImageReceipt {
  schemaVersion: "workloom.image-task-receipt/v1";
  requestSha256: string; identity: ImageIdentity;
  state: "submitting" | "accepted" | "unknown";
  createdAt: string; updatedAt: string; result?: ImageTaskResult; failureKind?: string;
}
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
function remoteUrl(raw: string): boolean {
  try { const url = new URL(raw); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}
function identity(input: { projectId: string; slotId: string; provider: string; endpoint: string; body: Record<string, unknown> }): ImageIdentity {
  if (![input.projectId, input.slotId, input.provider].every(value => typeof value === "string" && value.trim()) || !remoteUrl(input.endpoint)
    || !object(input.body) || typeof input.body.model !== "string" || !input.body.model.trim()) throw new Error("IMAGE_TASK_SCOPE_INVALID");
  const rejectSecretFields = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:api[_-]?key|authorization|access[_-]?token|password|secret)$/i.test(key)) throw new Error("IMAGE_TASK_SECRET_FIELD_FORBIDDEN");
      rejectSecretFields(child);
    }
  };
  const body = JSON.parse(filmCanonicalJson(input.body)) as Record<string, unknown>;
  rejectSecretFields(body);
  return { projectId: input.projectId, slotId: input.slotId, provider: input.provider, endpoint: input.endpoint, method: "POST", body };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function parsed(value: unknown, compiled: ImageIdentity, requestSha256: string): ImageReceipt | null {
  if (value === null) return null;
  if (!object(value) || value.schemaVersion !== "workloom.image-task-receipt/v1" || value.requestSha256 !== requestSha256
    || filmCanonicalJson(value.identity) !== filmCanonicalJson(compiled) || !["submitting", "accepted", "unknown"].includes(String(value.state))) throw new Error("IMAGE_TASK_RECEIPT_CHANGED: do not submit again");
  if (value.state === "accepted" && (!object(value.result) || typeof value.result.url !== "string" || !remoteUrl(value.result.url)
    || (value.result.size !== undefined && typeof value.result.size !== "string"))) throw new Error("IMAGE_TASK_RECEIPT_INVALID: accepted URL missing");
  return value as unknown as ImageReceipt;
}
export function imageTaskRequestHash(input: Parameters<typeof identity>[0]): string { return hash(filmCanonicalJson(identity(input))); }
export function imageTaskReceiptPath(root: string, input: Parameters<typeof identity>[0]): string { return new GenerationFileStore(root).path(imageTaskRequestHash(input)); }
/** Read-only acceptance lookup, useful for safe cache-lock recovery. */
export function readAcceptedImageTask(input: Parameters<typeof identity>[0] & { root: string }): ImageTaskResult | null {
  const compiled = identity(input), requestSha256 = hash(filmCanonicalJson(compiled));
  const receipt = parsed(new GenerationFileStore(input.root).load(requestSha256), compiled, requestSha256);
  return receipt?.state === "accepted" ? structuredClone(receipt.result!) : null;
}

export async function resumeOrSubmitImageTask(input: {
  root: string; projectId: string; slotId: string; provider: string; endpoint: string; body: Record<string, unknown>;
  submit: (frozenBody: Record<string, unknown>) => Promise<ImageTaskResult>;
  /** A legacy cache proves prior generation, but cannot prove that no provider accepted a request. */
  requireExisting?: boolean; lockTimeoutMs?: number;
}): Promise<ImageTaskResult> {
  const compiled = freeze(identity(input)), requestSha256 = hash(filmCanonicalJson(compiled));
  const store = new GenerationFileStore(input.root);
  const read = (): ImageReceipt | null => parsed(store.load(requestSha256), compiled, requestSha256);
  const previous = read();
  if (previous?.state === "accepted") return structuredClone(previous.result!);
  return store.locked(requestSha256, { timeoutMs: input.lockTimeoutMs ?? 300_000, canRecover: () => read()?.state === "accepted" }, async () => {
    const existing = read();
    if (existing?.state === "accepted") return structuredClone(existing.result!);
    if (existing) throw new Error("IMAGE_TASK_SUBMISSION_UNKNOWN: previous request may have been charged; no automatic POST");
    if (input.requireExisting) throw new Error("IMAGE_TASK_LEGACY_RECEIPT_REQUIRED: restore the prior provider acceptance before generating");
    const at = new Date().toISOString();
    const receipt: ImageReceipt = { schemaVersion: "workloom.image-task-receipt/v1", requestSha256, identity: compiled, state: "submitting", createdAt: at, updatedAt: at };
    store.save(requestSha256, receipt);
    let result: ImageTaskResult;
    try {
      result = await input.submit(compiled.body);
      if (!object(result) || typeof result.url !== "string" || !remoteUrl(result.url) || (result.size !== undefined && typeof result.size !== "string")) throw new Error("IMAGE_TASK_SUBMISSION_UNKNOWN: response has no usable URL");
    } catch (error) {
      receipt.state = "unknown"; receipt.updatedAt = new Date().toISOString(); receipt.failureKind = error instanceof Error ? error.name : "UnknownError";
      try { store.save(requestSha256, receipt); }
      catch (journalError) { throw new AggregateError([error, journalError], "Image submission and failure journaling failed; do not submit again"); }
      throw error;
    }
    receipt.state = "accepted"; receipt.updatedAt = new Date().toISOString();
    receipt.result = { url: result.url, ...(result.size ? { size: result.size } : {}) };
    store.save(requestSha256, receipt);
    return structuredClone(receipt.result);
  });
}
