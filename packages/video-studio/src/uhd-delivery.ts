/** Publish a verified UHD package into a new immutable directory generation. */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface UhdPublishInput {
  stagingDir: string;
  /** New immutable path, such as OUT_ROOT/uhd/versions/<run-id>. */
  publicDir: string;
  /** Stable pointer updated only after the generation is fully verified. */
  latestFile: string;
  assets: string[];
  manifestName: string;
  approved: boolean;
}

async function fingerprint(file: string): Promise<string> {
  const before = statSync(file);
  if (!before.isFile() || before.size < 1) throw new Error(`UHD_PUBLISH_EMPTY_ASSET: ${file}`);
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  const after = statSync(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
    throw new Error(`UHD_PUBLISH_ASSET_CHANGED: ${file}`);
  }
  return digest.digest("hex");
}

function safeRelative(file: string): string {
  if (!file || isAbsolute(file) || file.split(/[\\/]/).some((part) => !part || part === ".." || part === ".")) {
    throw new Error(`UHD_PUBLISH_UNSAFE_PATH: ${file}`);
  }
  return file;
}

function manifestReferences(manifest: Record<string, unknown>): Array<{ path: string; sha256: string }> {
  const result: Array<{ path: string; sha256: string }> = [];
  const deliverable = manifest.deliverable as { path?: unknown; sha256?: unknown } | undefined;
  if (typeof deliverable?.path !== "string" || typeof deliverable.sha256 !== "string") {
    throw new Error("UHD_PUBLISH_MANIFEST_MISSING_MASTER");
  }
  result.push({ path: deliverable.path, sha256: deliverable.sha256 });
  const variants = manifest.variants;
  if (!Array.isArray(variants) || variants.length === 0) throw new Error("UHD_PUBLISH_MANIFEST_MISSING_VARIANTS");
  for (const value of variants) {
    const item = value as { path?: unknown; sha256?: unknown; cover?: { path?: unknown; sha256?: unknown } | null };
    if (typeof item.path !== "string" || typeof item.sha256 !== "string") {
      throw new Error("UHD_PUBLISH_MANIFEST_INVALID_VARIANT");
    }
    result.push({ path: item.path, sha256: item.sha256 });
    if (item.cover) {
      if (typeof item.cover.path !== "string" || typeof item.cover.sha256 !== "string") {
        throw new Error("UHD_PUBLISH_MANIFEST_INVALID_COVER");
      }
      result.push({ path: item.cover.path, sha256: item.cover.sha256 });
    }
  }
  return result;
}

function manifestAssets(manifest: Record<string, unknown>): Array<{ path: string; sha256: string }> {
  if (!Array.isArray(manifest.assetSha256) || manifest.assetSha256.length === 0) {
    throw new Error("UHD_PUBLISH_MANIFEST_ASSETS_REQUIRED");
  }
  return manifest.assetSha256.map((value) => {
    if (!value || typeof value !== "object") throw new Error("UHD_PUBLISH_MANIFEST_ASSET_INVALID");
    const entry = value as { path?: unknown; sha256?: unknown };
    if (typeof entry.path !== "string" || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error("UHD_PUBLISH_MANIFEST_ASSET_INVALID");
    }
    return { path: entry.path, sha256: entry.sha256 };
  });
}

export async function publishUhdDelivery(
  input: UhdPublishInput,
  move: typeof renameSync = renameSync,
): Promise<{ publicDir: string; files: number; latestFile: string; manifestSha256: string }> {
  if (!input.approved) throw new Error("UHD_PUBLISH_GATE_NOT_APPROVED");
  const stagingDir = resolve(input.stagingDir), publicDir = resolve(input.publicDir), latestFile = resolve(input.latestFile);
  if (stagingDir === publicDir || publicDir.startsWith(`${stagingDir}${sep}`) || stagingDir.startsWith(`${publicDir}${sep}`)) {
    throw new Error("UHD_PUBLISH_DIRECTORY_OVERLAP");
  }
  if (latestFile.startsWith(`${publicDir}${sep}`) || latestFile === publicDir || existsSync(publicDir)) {
    throw new Error("UHD_PUBLISH_GENERATION_EXISTS_OR_POINTER_OVERLAP");
  }
  const manifestName = safeRelative(input.manifestName);
  const assets = [...new Set(input.assets.map(safeRelative))];
  if (!assets.includes(manifestName)) throw new Error("UHD_PUBLISH_MANIFEST_NOT_STAGED");
  const pending = join(dirname(publicDir), `.uhd-publish-${randomUUID()}`);
  const pointerPending = join(dirname(latestFile), `.uhd-latest-${randomUUID()}.json`);
  mkdirSync(dirname(publicDir), { recursive: true });
  mkdirSync(dirname(latestFile), { recursive: true });
  let generationMoved = false;
  try {
    mkdirSync(pending, { recursive: false });
    for (const asset of assets) {
      const source = join(stagingDir, asset), target = join(pending, asset);
      if (!lstatSync(source).isFile()) throw new Error(`UHD_PUBLISH_NON_FILE: ${source}`);
      const sourceSha = await fingerprint(source);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
      if (sourceSha !== await fingerprint(target) || sourceSha !== await fingerprint(source)) {
        throw new Error(`UHD_PUBLISH_COPY_MISMATCH: ${asset}`);
      }
    }
    const manifest = JSON.parse(readFileSync(join(pending, manifestName), "utf8")) as Record<string, unknown>;
    const declared = manifestAssets(manifest);
    const declaredRel = declared.map((entry) => safeRelative(relative(publicDir, resolve(entry.path))));
    if (new Set(declaredRel).size !== declaredRel.length
      || JSON.stringify([...declaredRel].sort()) !== JSON.stringify(assets.filter((asset) => asset !== manifestName).sort())) {
      throw new Error("UHD_PUBLISH_MANIFEST_ASSET_SET_MISMATCH");
    }
    for (const [index, entry] of declared.entries()) {
      if (await fingerprint(join(pending, declaredRel[index]!)) !== entry.sha256) {
        throw new Error(`UHD_PUBLISH_MANIFEST_DIGEST_MISMATCH: ${entry.path}`);
      }
    }
    for (const entry of manifestReferences(manifest)) {
      if (!/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("UHD_PUBLISH_INVALID_SHA256");
      const rel = relative(publicDir, resolve(entry.path));
      if (!assets.includes(safeRelative(rel)) || await fingerprint(join(pending, rel)) !== entry.sha256) {
        throw new Error(`UHD_PUBLISH_MANIFEST_DIGEST_MISMATCH: ${entry.path}`);
      }
    }
    // A new path needs only one rename to become a complete immutable generation.
    move(pending, publicDir); generationMoved = true;
    const manifestSha256 = await fingerprint(join(publicDir, manifestName));
    if (manifestSha256 !== await fingerprint(join(stagingDir, manifestName))) {
      throw new Error("UHD_PUBLISH_MANIFEST_CHANGED_AFTER_SWAP");
    }
    writeFileSync(pointerPending, `${JSON.stringify({
      schemaVersion: "workloom.uhd-latest/v1", publicDir, manifest: join(publicDir, manifestName),
      manifestSha256, publishedAt: new Date().toISOString(),
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    move(pointerPending, latestFile);
    return { publicDir, files: assets.length, latestFile, manifestSha256 };
  } catch (error) {
    // The stable pointer has not changed, so the previous official generation
    // (and any legacy flat files) is still the visible release.
    if (generationMoved) rmSync(publicDir, { recursive: true, force: true });
    if (existsSync(pending)) rmSync(pending, { recursive: true, force: true });
    if (existsSync(pointerPending)) rmSync(pointerPending, { force: true });
    throw error;
  }
}
