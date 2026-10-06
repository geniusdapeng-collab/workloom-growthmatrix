/** Invocation-bound artifact reads. Callers supply an index, never a file path. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TRPCError } from "@trpc/server";
import type { FilmJobRow } from "../video/film-ledger.js";
import { archiveWorkDir } from "../video/archive-host.js";

const MAX_BYTES = 24 * 1024 * 1024;
const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".wav": "audio/wav", ".mp3": "audio/mpeg",
  ".json": "application/json", ".md": "text/markdown", ".txt": "text/plain", ".html": "text/html", ".pdf": "application/pdf",
  ".csv": "text/csv", ".tsv": "text/tab-separated-values", ".svg": "image/svg+xml",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const within = (root: string, file: string): boolean => file.startsWith(root + sep);
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export interface AgentArtifact { path: string; expectedSha256?: string; expectedBytes?: number }
export interface AgentArtifactView {
  index: number; mime: string; bytes: number | null; sha256: string | null;
  byteVerified: boolean; sourceVerified: boolean; downloadable: boolean; error?: string;
}

export function artifactsFromEvents(events: unknown[]): AgentArtifact[] {
  const items = new Map<string, AgentArtifact>();
  for (const event of events) {
    const after = record(record(record(event).decision).after);
    for (const container of [after, record(after.result)]) {
      if (!Array.isArray(container.outputs)) continue;
      for (const raw of container.outputs) {
        const item = record(raw);
        const path = typeof item.path === "string" ? item.path : typeof item.file === "string" ? item.file : null;
        if (!path) continue;
        const hash = typeof item.sha256 === "string" ? item.sha256 : typeof item.hash === "string" ? item.hash : undefined;
        items.set(path, { path,
          ...(hash && /^[a-f0-9]{64}$/.test(hash) ? { expectedSha256: hash } : {}),
          ...(typeof item.bytes === "number" && Number.isSafeInteger(item.bytes) && item.bytes >= 0 ? { expectedBytes: item.bytes } : {}),
        });
      }
    }
  }
  return [...items.values()];
}

export function taskArtifactRoots(workspaceId: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const support = env.WORKLOOM_VISUAL_BRIDGE_SUPPORT_DIR ?? join(homedir(), "Library", "Application Support", "WorkLoomVisualBridge");
  return [...(env.WORKLOOM_ARTIFACT_ROOTS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
    join(support, "var", "tenants", workspaceId), resolve("outputs"), resolve("var")];
}

/** File descriptor and final canonical path are checked together to detect link replacement. */
async function readRegistered(item: AgentArtifact, roots: string[]): Promise<{ bytes: Buffer; mime: string; digest: string }> {
  const mime = MIME[extname(item.path).toLowerCase()];
  if (!mime) throw new TRPCError({ code: "BAD_REQUEST", message: "该登记产物格式不支持取件" });
  let file: string;
  try { file = await realpath(item.path); }
  catch { throw new TRPCError({ code: "NOT_FOUND", message: "登记产物文件不存在或不可读" }); }
  const canonicalRoots = await Promise.all(roots.map(async (root) => {
    try { return { configured: resolve(root), canonical: await realpath(root) }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "产物根目录无法核验", cause: error });
    }
  }));
  const absolute = resolve(item.path);
  const allowed = canonicalRoots.find((root) => root && within(root.canonical, file)
    && (within(root.configured, absolute) || within(root.canonical, absolute)));
  if (!allowed) {
    throw new TRPCError({ code: "FORBIDDEN", message: "登记产物越出允许的资产根目录" });
  }
  // Reject links below the configured root, including links that resolve back inside it.
  const base = within(allowed.configured, absolute) ? allowed.configured : allowed.canonical;
  let component = base;
  for (const part of relative(base, absolute).split(sep)) {
    component = join(component, part);
    const info = await lstat(component).catch(error => {
      throw new TRPCError({ code: "NOT_FOUND", message: "登记产物路径无法核验", cause: error });
    });
    if (info.isSymbolicLink()) throw new TRPCError({ code: "FORBIDDEN", message: "登记产物不接受符号链接路径" });
  }
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    .catch((error) => { throw new TRPCError({ code: "NOT_FOUND", message: "登记产物无法安全打开", cause: error }); });
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size === 0) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "登记产物为空或不是普通文件" });
    if (before.nlink !== 1) throw new TRPCError({ code: "FORBIDDEN", message: "登记产物不接受硬链接" });
    if (before.size > MAX_BYTES) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "产物超过 24 MiB 在线取件上限，请使用已登记的客户档案" });
    // One extra byte detects growth without allocating or reading an unbounded file.
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.byteLength) {
      const read = await handle.read(buffer, length, buffer.byteLength - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    const after = await handle.stat();
    const canonicalAfter = await realpath(item.path);
    const pathAfter = await stat(canonicalAfter);
    if (canonicalAfter !== file || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.nlink !== after.nlink
      || before.dev !== pathAfter.dev || before.ino !== pathAfter.ino || bytes.byteLength !== before.size) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "读取期间产物发生变化" });
    }
    const digest = sha256(bytes);
    if (item.expectedBytes !== undefined && item.expectedBytes !== bytes.byteLength
      || item.expectedSha256 !== undefined && item.expectedSha256 !== digest) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "产物字节与登记摘要或大小不符" });
    }
    return { bytes, mime, digest };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "登记产物读取期间不可核验", cause: error });
  } finally { await handle.close(); }
}

export async function inspectAgentArtifacts(items: AgentArtifact[], roots: string[]): Promise<AgentArtifactView[]> {
  const views: AgentArtifactView[] = [];
  for (const [index, item] of items.entries()) {
    try {
      const file = await readRegistered(item, roots);
      views.push({ index, mime: file.mime, bytes: file.bytes.byteLength, sha256: file.digest,
        byteVerified: true, sourceVerified: item.expectedSha256 !== undefined, downloadable: true });
    } catch (error) {
      if (!(error instanceof TRPCError)) throw error;
      views.push({ index, mime: MIME[extname(item.path).toLowerCase()] ?? "application/octet-stream", bytes: item.expectedBytes ?? null,
        sha256: item.expectedSha256 ?? null, byteVerified: false, sourceVerified: false, downloadable: false, error: error.code });
    }
  }
  return views;
}

export async function agentArtifactData(items: AgentArtifact[], index: number, roots: string[]): Promise<Record<string, unknown>> {
  const item = items[index];
  if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "调用没有这个序号的登记产物" });
  const file = await readRegistered(item, roots);
  return { index, mime: file.mime, bytes: file.bytes.byteLength, sha256: file.digest, base64: file.bytes.toString("base64"),
    byteVerified: true, sourceVerified: item.expectedSha256 !== undefined, businessVerified: false };
}

function relativeArtifact(root: string, ref: unknown): string {
  if (typeof ref !== "string" || isAbsolute(ref) || ref.length > 1000 || /[\0\r\n]/.test(ref)
    || ref.split(/[\\/]/).some((part) => part === "" || part === "." || part === "..")) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "工位产物引用非法" });
  }
  const file = resolve(root, ref);
  if (!within(root, file)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "工位产物引用越界" });
  return file;
}

/** Re-read the immutable finished job result and verify its digest before trusting its index. */
export async function filmArtifacts(job: FilmJobRow, env: NodeJS.ProcessEnv = process.env): Promise<{ items: AgentArtifact[]; roots: string[] }> {
  if (job.status !== "finished") return { items: [], roots: [] };
  for (const value of [job.workspace_id, job.project_id]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value) || value.includes("..")) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "工位租户或项目档案标识不可作为安全目录" });
    }
  }
  const root = resolve(archiveWorkDir(env), "archive", job.workspace_id, job.project_id);
  const expectedRef = `stages/film/attempt-${job.attempt}/film-result.json`;
  if (job.result_ref !== expectedRef || !job.result_sha256) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "工位终态缺少匹配的结果引用与摘要" });
  }
  const source = await readRegistered({ path: relativeArtifact(root, job.result_ref), expectedSha256: job.result_sha256 }, [root]);
  let result: Record<string, unknown>;
  try { result = record(JSON.parse(source.bytes.toString("utf8"))); }
  catch { throw new TRPCError({ code: "PRECONDITION_FAILED", message: "工位结果不是合法 JSON" }); }
  if (result.schemaVersion !== "workloom.film-result/v1" || result.jobId !== job.id || result.projectId !== job.project_id
    || result.runId !== job.run_id || result.attempt !== job.attempt || result.inputSha256 !== job.input_sha256
    || result.complete !== true || !Array.isArray(result.artifacts)) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "工位结果与本次不可换绑的作业不符" });
  }
  const work = dirname(relativeArtifact(root, job.result_ref));
  const items = result.artifacts.map((raw) => {
    const artifact = record(raw);
    if (typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256)
      || !Number.isSafeInteger(artifact.bytes) || Number(artifact.bytes) <= 0) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "工位结果缺少有效的产物摘要或大小" });
    }
    return { path: relativeArtifact(work, artifact.ref), expectedSha256: artifact.sha256, expectedBytes: Number(artifact.bytes) };
  });
  return { items, roots: [work] };
}
