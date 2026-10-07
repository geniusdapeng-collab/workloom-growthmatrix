/** Fixed local runbook. No client-selected files, models, service or media calls. */
import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join, resolve } from "node:path";
import { TextDecoder } from "node:util";

export const GUIDE_PATH = "docs/ai-video-workbench-guide.md";
export const GUIDE_VERSION = "2026-10-07.1";
const PRODUCT_ID = "workloom-ai-growthmatrix";
const REPOSITORY = "workloom-ai/WorkLoom-growthmatrix";
const MAX_BYTES = 512 * 1024;
const ROOT = resolve(import.meta.dirname, "..", "..", "..");

export class WorkbenchGuideError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkbenchGuideError";
    this.code = code;
  }
}

function fail(code, message) { throw new WorkbenchGuideError(code, message); }

function readFixed(ref) {
  const segments = ref.split("/");
  let candidate = ROOT;
  for (const [index, segment] of segments.entries()) {
    candidate = join(candidate, segment);
    const info = lstatSync(candidate, { throwIfNoEntry: false });
    if (!info) fail("GUIDE_MISSING", `固定指南依赖缺失：${ref}；请修复或更新本仓运行载荷`);
    if (info.isSymbolicLink() || (index < segments.length - 1 ? !info.isDirectory() : !info.isFile())) {
      fail("GUIDE_PATH_INVALID", `固定指南依赖必须是本仓普通文件，不能经过符号链接：${ref}`);
    }
  }
  const handle = openSync(candidate, "r");
  try {
    const info = fstatSync(handle);
    if (!info.isFile() || info.size > MAX_BYTES) fail("GUIDE_TOO_LARGE", `固定指南依赖超过 ${MAX_BYTES} 字节或不是普通文件：${ref}`);
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0, bytes;
    while (size < buffer.length && (bytes = readSync(handle, buffer, size, buffer.length - size, null)) > 0) size += bytes;
    if (size > MAX_BYTES) fail("GUIDE_TOO_LARGE", `固定指南依赖超过 ${MAX_BYTES} 字节：${ref}`);
    return buffer.subarray(0, size);
  } finally { closeSync(handle); }
}

function decode(bytes, ref) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { fail("GUIDE_INVALID", `固定指南依赖不是有效 UTF-8：${ref}`); }
}

export function workbenchGuide(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length
      || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    fail("GUIDE_INPUT_INVALID", "指南只接受空 JSON 对象 {}，不接受 path、projectId 或其他字段");
  }
  let product;
  try { product = JSON.parse(decode(readFixed("product.manifest.json"), "product.manifest.json")); }
  catch (error) {
    if (error instanceof WorkbenchGuideError) throw error;
    fail("GUIDE_INVALID", "product.manifest.json 不是合法 JSON");
  }
  if (product?.productId !== PRODUCT_ID || product?.repository !== REPOSITORY || product?.defaultBundle !== "geo-growthmatrix") {
    fail("GUIDE_PRODUCT_MISMATCH", "当前产品清单与 Matrix 视频工作台指南不匹配");
  }
  const bytes = readFixed(GUIDE_PATH);
  const content = decode(bytes, GUIDE_PATH);
  if (!content.startsWith(`---\nguideVersion: ${GUIDE_VERSION}\nproductId: ${PRODUCT_ID}\nrepository: ${REPOSITORY}\n---\n`)) {
    fail("GUIDE_INVALID", "固定指南头部、版本或产品标识不符；请更新本仓模块和指南");
  }
  return {
    path: GUIDE_PATH, guideVersion: GUIDE_VERSION, productId: PRODUCT_ID, repository: REPOSITORY,
    sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length,
    format: "text/markdown; charset=utf-8", content,
    boundaries: {
      readOnly: true, networkCalled: false, modelCalled: false, mediaGenerated: false,
      nativeStandardPostAvailable: false, serviceProjectRequiredForFilmStart: true,
    },
  };
}
