/** Project-scoped, content-addressed post-production assets for a frozen server job. */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { FilmChannelError, filmCanonicalJson } from "./film-worker-channel.js";
import { readFilmPresentation } from "./film-presentation.js";

const ids = ["cool-tech", "warm-film", "punchy-social"];
const hash = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const within = (root: string, file: string): boolean => file.startsWith(root + sep);
const fail = (message: string): never => { throw new FilmChannelError("POST_ASSET_INVALID", message); };
export function filmArchiveRef(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 1_000 || isAbsolute(value) || /[\\\0\r\n]/u.test(value)
    || value.split("/").some(part => !part || part === "." || part === ".." || part.includes(":"))) fail("后期资产必须使用项目档案内的相对引用");
  return value as string;
}
function bytesAt(root: string, file: string, expected: unknown, limit: number): Buffer {
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/u.test(expected)) fail("后期资产必须声明 sha256");
  if (!within(root, resolve(file)) || !within(root, realpathSync(file))) fail("后期资产引用越出项目档案");
  const handle = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(handle);
    if (!info.isFile() || info.size <= 0 || info.size > limit) fail("后期资产不是可读取的有界普通文件");
    const bytes = readFileSync(handle);
    if (!bytes.length || bytes.length > limit || hash(bytes) !== expected) fail("后期资产字节、大小或摘要不符");
    return bytes;
  } finally { closeSync(handle); }
}
function frozenFile(root: string, ref: string, bytes: Buffer | string): void {
  const file = join(root, ref), parent = dirname(file);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!within(root, realpathSync(parent))) fail("冻结后期资产路径越出项目档案");
  const digest = hash(bytes);
  if (existsSync(file)) { bytesAt(root, file, digest, 64 * 1024 * 1024); return; }
  const temporary = join(parent, `.post-${randomUUID()}.tmp`);
  const handle = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(handle, bytes); fsyncSync(handle); } finally { closeSync(handle); }
  try {
    try { linkSync(temporary, file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    bytesAt(root, file, digest, 64 * 1024 * 1024);
    const directory = openSync(parent, constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { unlinkSync(temporary); }
}
export interface FilmJobPostAssets { endCard?: { file: string; bytes: Buffer }; presentation?: { file: string; document: Record<string, unknown>; assets: Map<string, Buffer> } }
/** Verify the plan and every nested asset before a worker can reach a provider. */
export function readFilmJobPostAssets(archiveRoot: string, options: Record<string, unknown>): FilmJobPostAssets {
  const root = realpathSync(archiveRoot), result: FilmJobPostAssets = {};
  if (options["end-card-ref"]) {
    const file = join(root, filmArchiveRef(options["end-card-ref"]));
    if (![".png", ".jpg", ".jpeg", ".webp"].includes(extname(file).toLowerCase())) fail("结尾卡必须为图片");
    result.endCard = { file, bytes: bytesAt(root, file, options["end-card-sha256"], 16 * 1024 * 1024) };
  }
  if (options["presentation-plan-ref"]) {
    const file = join(root, filmArchiveRef(options["presentation-plan-ref"]));
    const planBytes = bytesAt(root, file, options["presentation-plan-sha256"], 512 * 1024);
    const document = JSON.parse(planBytes.toString("utf8")) as Record<string, unknown>;
    if (!document || typeof document !== "object" || Array.isArray(document) || document.schemaVersion !== "workloom.film-presentation/v1"
      || !Array.isArray(document.variants) || document.variants.length !== ids.length) fail("后期计划格式非法");
    const assets = new Map<string, Buffer>();
    let total = 0;
    for (const raw of [document.main, ...(document.variants as unknown[])]) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("后期版本格式非法");
      for (const key of ["font", "cover", "endCard", "bgm"]) {
        const asset = (raw as Record<string, unknown>)[key] as { path?: unknown; sha256?: unknown };
        if (!asset || typeof asset !== "object" || Array.isArray(asset)) fail("后期计划缺资产");
        const assetFile = resolve(dirname(file), filmArchiveRef(asset.path));
        const bytes = bytesAt(root, assetFile, asset.sha256, 64 * 1024 * 1024);
        total += bytes.length;
        if (total > 256 * 1024 * 1024) fail("后期资产总大小超限");
        assets.set(assetFile, bytes);
      }
    }
    readFilmPresentation(file, ids);
    // Reject concurrent changes between validation and the presentation reader.
    bytesAt(root, file, options["presentation-plan-sha256"], 512 * 1024);
    for (const [assetFile, bytes] of assets) bytesAt(root, assetFile, hash(bytes), 64 * 1024 * 1024);
    result.presentation = { file, document, assets };
  }
  return result;
}
/** Content-addressed copies prevent later edits to an uploaded plan from changing a queued job. */
export function freezeFilmJobPostAssets(archiveRoot: string, options: Record<string, string | boolean>): Record<string, string | boolean> {
  const root = realpathSync(archiveRoot), next = { ...options }, validated = readFilmJobPostAssets(root, options);
  const base = "stages/film/post-assets";
  const freeze = (file: string, bytes: Buffer): string => {
    const ref = `${base}/assets/${hash(bytes)}${extname(file).toLowerCase()}`;
    frozenFile(root, ref, bytes); return ref;
  };
  if (validated.endCard) next["end-card-ref"] = freeze(validated.endCard.file, validated.endCard.bytes);
  if (validated.presentation) {
    const { file, document, assets } = validated.presentation;
    for (const raw of [document.main, ...(document.variants as unknown[])]) {
      for (const key of ["font", "cover", "endCard", "bgm"]) {
        const asset = (raw as Record<string, unknown>)[key] as { path: string; sha256: string };
        const source = resolve(dirname(file), asset.path), bytes = assets.get(source)!;
        asset.path = relative(join(root, base), join(root, freeze(source, bytes))).split(sep).join("/");
      }
    }
    const payload = filmCanonicalJson(document), digest = hash(payload), ref = `${base}/${digest}.json`;
    frozenFile(root, ref, payload);
    next["presentation-plan-ref"] = ref;
    next["presentation-plan-sha256"] = digest;
  }
  return next;
}
