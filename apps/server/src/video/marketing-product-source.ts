/** 已登记客户商品摘录来源。请求只能选择正式库中的 id，不能提交任意本地文件或自造正文。 */
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { normalizeProductName, verifyProductArchive, type ProductArchive } from "@hyperreality/video-studio";
import { canonicalRenderJson, renderSha256 } from "./gen/compiled-request.js";
import { SubmissionError } from "./gen/submission-ledger.js";
import { SOURCE_MAX_BYTES, SOURCE_MAX_TEXT_CHARS, type SourceSnapshot } from "./marketing-source-fetcher.js";

export const PRODUCT_SOURCE_TYPE = "application/vnd.workloom.registered-product-archive+json";
const libraryRoot = fileURLToPath(new URL("../../../../bundles/ai-video/library/products/", import.meta.url));
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1).max(8000);
const evidence = z.object({ quote: text, file: text, slide: z.number().int().positive(), deckSha256: hash,
  query: text, url: text }).passthrough();
const archiveSchema = z.object({
  schemaVersion: z.literal("workloom.product-archive/v1"), id, displayName: text,
  type: z.literal("product").optional(), model: text.optional(), company: text.optional(), brand: text.optional(),
  aliases: z.array(text).max(100).optional(),
  source: z.object({ kind: z.literal("user-upload"), priority: z.literal(10), reviewStatus: z.literal("owner-confirmed"),
    evidence: z.array(evidence).min(1).max(100),
    extraction: z.object({ method: text, verified: z.boolean(), note: text.optional() }).passthrough().optional(),
  }).passthrough(),
  photos: z.array(z.object({ id: text, file: text, sha256: hash, bytes: z.number().int().positive(),
    role: z.enum(["hero", "detail", "scene", "packaging"]).optional(),
    width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
  }).passthrough()).min(1).max(100),
  specs: z.object({ appearance: text.optional(), material: text.optional(), features: z.array(text).optional(),
    parameters: z.array(z.object({ name: text, value: text, source: text.optional() }).passthrough()).optional(),
    notes: z.array(z.string()).optional(),
  }).passthrough().optional(),
}).passthrough();

export interface ProductSourceProvenance {
  schemaVersion: "workloom.registered-product-source/v1";
  archiveId: string;
  archiveRef: string;
  archiveSha256: string;
  originalReopened: false;
  extractionVerified: boolean;
  evidence: Array<{ file: string; page: number; originalSha256: string; quote: string }>;
}
export interface ProductSourceSnapshot extends SourceSnapshot { archive: ProductSourceProvenance }
export interface RegisteredProductSource {
  snapshot: ProductSourceSnapshot; rawBytes: Buffer; productQuery: Record<string, string>; archive: ProductArchive; dir: string;
}
export interface ProductVisualReference {
  sourceId: string; archiveId: string; archiveSha256: string; photoId: string;
  file: string; path: string; sha256: string; bytes: number;
}
function fail(code: string, message: string): never { throw new SubmissionError(code, message); }
function parseArchive(bytes: Buffer): ProductArchive {
  if (!bytes.length || bytes.length > SOURCE_MAX_BYTES) fail("MARKETING_ARCHIVE_INVALID", "登记档案字节为空或超过读取上限");
  try { return archiveSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))) as unknown as ProductArchive; }
  catch { fail("MARKETING_ARCHIVE_INVALID", "登记档案缺少有效客户来源、原件摘要、页码或原文摘录"); }
}
function descriptor(archive: ProductArchive, archiveSha256: string): { text: string; archive: ProductSourceProvenance } {
  // 正文只含保存的摘录，specs/名称映射/owner-confirmed 都不是原文主张的证明。
  const entries = archive.source.evidence!;
  const body = entries.map(entry => entry.quote!).join("\n\n");
  if (body.length > SOURCE_MAX_TEXT_CHARS) fail("MARKETING_ARCHIVE_TOO_LARGE", "登记摘录超过完整来源审核上限，禁止截断");
  return { text: body, archive: { schemaVersion: "workloom.registered-product-source/v1",
    archiveId: archive.id, archiveRef: `bundles/ai-video/library/products/${archive.id}/profile.json`, archiveSha256,
    originalReopened: false, extractionVerified: archive.source.extraction?.verified === true,
    evidence: entries.map(entry => ({ file: entry.file!, page: entry.slide!, originalSha256: entry.deckSha256!, quote: entry.quote! })),
  } };
}
function sourceAddress(archiveId: string, archiveSha256: string): string {
  return `workloom-archive://${archiveId}/profile/${archiveSha256}`;
}

/** libraryRoot 仅供宿主依赖装配/测试使用；永不从浏览器 metadata 读取。 */
export async function loadRegisteredProductSource(selector: unknown, options: { libraryRoot?: string } = {}): Promise<RegisteredProductSource | null> {
  if (selector === undefined || selector === null) return null;
  const object = selector && typeof selector === "object" && !Array.isArray(selector) ? selector as Record<string, unknown> : null;
  const parsedId = id.safeParse(typeof selector === "string" ? selector : object?.id);
  if (!parsedId.success) fail("MARKETING_ARCHIVE_SELECTOR_INVALID", "商品来源只能选择已登记的档案 id");
  const archiveId = parsedId.data;
  const configuredRoot = path.resolve(options.libraryRoot ?? libraryRoot);
  const root = await realpath(configuredRoot);
  if (root !== configuredRoot) fail("MARKETING_ARCHIVE_PATH_INVALID", "商品档案库不能经过符号链接");
  const dir = path.join(root, archiveId), file = path.join(dir, "profile.json");
  let resolvedDir: string, resolvedFile: string;
  try { resolvedDir = await realpath(dir); resolvedFile = await realpath(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") fail("MARKETING_ARCHIVE_NOT_FOUND", "所选商品档案未在正式库登记");
    throw error;
  }
  if (resolvedDir !== dir || resolvedFile !== file) fail("MARKETING_ARCHIVE_PATH_INVALID", "商品档案路径不能越界或经过符号链接");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let rawBytes: Buffer;
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.size > SOURCE_MAX_BYTES) fail("MARKETING_ARCHIVE_INVALID", "商品档案不是受限大小的普通文件");
    rawBytes = await handle.readFile();
  } finally { await handle.close(); }
  const archive = parseArchive(rawBytes);
  if (archive.id !== archiveId) fail("MARKETING_ARCHIVE_ID_MISMATCH", "档案目录与登记身份不一致");
  if (object && Object.keys(object).some(key => key !== "id") && canonicalRenderJson(object) !== canonicalRenderJson(JSON.parse(rawBytes.toString("utf8")))) {
    fail("MARKETING_ARCHIVE_CHANGED", "请求中的商品档案与正式库字节内容不一致；只传 id 或更新登记档案");
  }
  for (const photo of archive.photos) {
    const candidate = path.resolve(dir, photo.file);
    if (path.isAbsolute(photo.file) || photo.file.includes("\\") || photo.file.split("/").some(part => part === ".." || part === ".")
      || !candidate.startsWith(`${dir}${path.sep}`) || await realpath(candidate) !== candidate) {
      fail("MARKETING_ARCHIVE_PATH_INVALID", "登记商品图片不能越界或经过符号链接");
    }
    const info = await stat(candidate);
    if (!info.isFile() || info.size > 30 * 1024 * 1024) fail("MARKETING_ARCHIVE_INVALID", "登记商品图片不是受限大小的普通文件");
  }
  const hard = verifyProductArchive(archive, { dir }).filter(issue => issue.hard);
  if (hard.length) fail("MARKETING_ARCHIVE_INVALID", hard.map(issue => `${issue.code}：${issue.detail}`).join("；"));
  const rawSha256 = renderSha256(rawBytes), document = descriptor(archive, rawSha256);
  const url = sourceAddress(archive.id, rawSha256), textSha256 = renderSha256(document.text);
  return { rawBytes, archive, dir, productQuery: { name: archive.displayName, ...(archive.brand ? { brand: archive.brand } : {}),
    ...(archive.model ? { model: archive.model } : {}) }, snapshot: {
    sourceId: `SRC-${renderSha256(`${url}\n${textSha256}`).slice(0, 24)}`, requestedUrl: url, finalUrl: url, redirectChain: [],
    fetchedAt: new Date().toISOString(), contentType: PRODUCT_SOURCE_TYPE, rawSha256, textSha256, bytes: rawBytes.length,
    ...document, assetUrls: [],
  } };
}

/** 视觉证据独立于摘录claims；只从当前正式库复开与已归档profile字节相同的图档。 */
export async function loadProductVisualReferences(sources: Array<{ sourceId: string; rawSha256: string; archive?: ProductSourceProvenance }>,
  options: { libraryRoot?: string } = {}): Promise<ProductVisualReference[]> {
  const references: ProductVisualReference[] = [];
  for (const source of sources) {
    if (!source.archive) continue;
    const current = (await loadRegisteredProductSource(source.archive.archiveId, options))!;
    if (current.snapshot.rawSha256 !== source.rawSha256 || current.snapshot.rawSha256 !== source.archive.archiveSha256
      || canonicalRenderJson(current.snapshot.archive) !== canonicalRenderJson(source.archive)
      || current.snapshot.sourceId !== source.sourceId) fail("MARKETING_VISUAL_SOURCE_CHANGED", "当前商品图档与原审核来源不一致");
    for (const photo of current.archive.photos) references.push({ sourceId: source.sourceId, archiveId: current.archive.id,
      archiveSha256: current.snapshot.rawSha256, photoId: photo.id, file: photo.file,
      path: path.join(current.dir, photo.file), sha256: photo.sha256, bytes: photo.bytes });
  }
  if (references.length > 6) fail("MARKETING_VISUAL_BUDGET_EXCEEDED", "登记图档超过完整单次视觉审核预算；不能静默截取");
  return references;
}

export function assertProductSourceQuery(source: RegisteredProductSource, query: Record<string, unknown>): void {
  const archive = source.archive;
  const names = [archive.id, archive.displayName, archive.model, ...(archive.aliases ?? [])].filter(Boolean).map(normalizeProductName);
  if (typeof query.name !== "string" || !names.includes(normalizeProductName(query.name))
    || query.brand !== undefined && normalizeProductName(query.brand) !== normalizeProductName(archive.brand)
    || query.model !== undefined && normalizeProductName(query.model) !== normalizeProductName(archive.model)) {
    fail("MARKETING_ARCHIVE_PRODUCT_MISMATCH", "检索商品名称、品牌或型号与所选登记档案不一致");
  }
}

/** 复读归档字节重建摘录与出处；档案标签、自报 originalReopened 和落盘通过字段不授予资格。 */
export function verifyArchivedProductSource(snapshot: SourceSnapshot & { archive?: ProductSourceProvenance }, rawBytes: Buffer): void {
  const archive = parseArchive(rawBytes), rawSha256 = renderSha256(rawBytes), document = descriptor(archive, rawSha256);
  const url = sourceAddress(archive.id, rawSha256), textSha256 = renderSha256(document.text);
  if (snapshot.contentType !== PRODUCT_SOURCE_TYPE || snapshot.requestedUrl !== url || snapshot.finalUrl !== url
    || snapshot.redirectChain.length !== 0 || snapshot.rawSha256 !== rawSha256 || snapshot.bytes !== rawBytes.length
    || snapshot.text !== document.text || snapshot.textSha256 !== textSha256 || snapshot.assetUrls.length !== 0
    || snapshot.sourceId !== `SRC-${renderSha256(`${url}\n${textSha256}`).slice(0, 24)}`
    || canonicalRenderJson(snapshot.archive) !== canonicalRenderJson(document.archive)) {
    fail("MARKETING_ARCHIVE_CHANGED", "归档商品来源、摘录或原件未复核标记与保存字节不一致");
  }
}
