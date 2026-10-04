// Register workspace exports without moving their source files. Moving a package into
// node_modules breaks repo-relative imports and creates a second copy of its state.
// Real ESM facades survive Windows ZIP extraction without junctions or symlinks.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPayloadPolicy } from "./payload-policy.mjs";

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

// Resolve a not-yet-created path through its existing ancestors. Validation
// must precede mkdir: mkdir can already cross an ancestor symlink.
function canonicalPath(candidate) {
  const suffix = [];
  let ancestor = resolve(candidate);
  while (!lstatSync(ancestor, { throwIfNoEntry: false })) {
    suffix.unshift(basename(ancestor));
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`路径没有可解析的父目录：${candidate}`);
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), ...suffix);
}

function validateDestination(root, candidate, label) {
  if (!inside(root, candidate) || !inside(root, canonicalPath(candidate))) throw new Error(`${label}越界：${candidate}`);
  const info = lstatSync(candidate, { throwIfNoEntry: false });
  if (info?.isSymbolicLink() || info?.isFile() && info.nlink !== 1) throw new Error(`${label}链接越界：${candidate}`);
  if (info && !info.isFile() && !info.isDirectory()) throw new Error(`${label}不接受特殊文件：${candidate}`);
  return info;
}

// Skip development dependency trees before traversing them. Dereferencing pnpm
// links and deleting the result later can exhaust the packaging machine's disk.
export function copyRuntimeSources(repositoryRoot, runtimeRoot, sourcePaths) {
  const sourceRoot = realpathSync(resolve(repositoryRoot));
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) throw new Error("缺少载荷源码路径");
  const canonicalDestination = canonicalPath(runtimeRoot);
  const copied = [];
  const plans = new Map();
  for (const sourcePath of sourcePaths) {
    if (typeof sourcePath !== "string" || !sourcePath || isAbsolute(sourcePath)) throw new Error("载荷源码路径必须是仓库相对路径");
    const source = resolve(sourceRoot, sourcePath);
    if (source === sourceRoot || !inside(sourceRoot, source)) throw new Error(`载荷源码路径越界：${sourcePath}`);
    if (!lstatSync(source, { throwIfNoEntry: false })) continue;
    if (!inside(sourceRoot, realpathSync(source))) throw new Error(`载荷源码链接越界：${sourcePath}`);
    if (inside(realpathSync(source), canonicalDestination) || inside(canonicalDestination, sourceRoot))
      throw new Error(`载荷目标不可位于源码目录内或覆盖工作区：${sourcePath}`);
    const walk = (candidate, ancestors) => {
      if (basename(candidate) === "node_modules") return;
      const canonical = realpathSync(candidate);
      if (!inside(sourceRoot, canonical)) throw new Error(`载荷源码链接越界：${relative(sourceRoot, candidate)}`);
      const info = statSync(candidate);
      const destination = resolve(canonicalDestination, relative(sourceRoot, candidate));
      const existing = validateDestination(canonicalDestination, destination, "载荷目标");
      if (existing && existing.isDirectory() !== info.isDirectory()) throw new Error(`载荷目标类型冲突：${destination}`);
      if (info.isDirectory()) {
        if (ancestors.has(canonical)) throw new Error(`载荷源码链接越界或循环：${candidate}`);
        plans.set(destination, { source: candidate, directory: true });
        const next = new Set([...ancestors, canonical]);
        for (const entry of readdirSync(candidate).sort()) walk(join(candidate, entry), next);
      } else if (info.isFile()) {
        plans.set(destination, { source: candidate, directory: false });
      } else throw new Error(`载荷源码不接受特殊文件：${candidate}`);
    };
    walk(source, new Set());
    copied.push(sourcePath);
  }
  // No directory, copy or replacement occurs until every source and target is
  // validated, including invalid entries late in a selected directory tree.
  mkdirSync(canonicalDestination, { recursive: true });
  for (const [destination, plan] of plans) {
    validateDestination(canonicalDestination, destination, "载荷目标");
    if (plan.directory) mkdirSync(destination, { recursive: true });
    else {
      mkdirSync(dirname(destination), { recursive: true });
      validateDestination(canonicalDestination, destination, "载荷目标");
      cpSync(plan.source, destination, { dereference: true, preserveTimestamps: true });
    }
  }
  return copied;
}

export function registerWorkspaceModules(runtimeRoot) {
  const root = realpathSync(resolve(runtimeRoot));
  const policy = loadPayloadPolicy(root);
  const sources = readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => join(root, "packages", entry.name)).sort();
  if (policy.includePlatformOps) sources.push(join(root, "platform-ops"));
  const names = new Set();
  const plans = [];
  for (const source of sources) {
    const manifestPath = join(source, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const name = manifest.name;
    if (typeof name !== "string" || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u.test(name)
      || name.split("/").some((part) => part === "." || part === "..")) {
      throw new Error(`工作区包名称无效：${manifestPath}`);
    }
    if (names.has(name)) throw new Error(`工作区包名称重复：${name}`);
    names.add(name);
    if (manifest.type !== "module" || !manifest.exports) {
      throw new Error(`工作区包必须声明 ESM exports：${name}`);
    }
    const destination = join(root, "node_modules", name);
    validateDestination(root, dirname(destination), "工作区注册目录");
    validateDestination(root, destination, "工作区注册目录");
    const files = [];
    const targets = new Map();
    const rewrite = (value) => {
      if (value === null) return null;
      if (Array.isArray(value)) return value.map(rewrite);
      if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => {
          if (key.includes("*")) throw new Error(`工作区包通配 exports 尚未支持：${name}.${key}`);
          return [key, rewrite(child)];
        }));
      }
      if (typeof value !== "string" || !value.startsWith("./") || value.includes("*") || value.includes("\\")) {
        throw new Error(`工作区包 exports 目标无效：${name} ${String(value)}`);
      }
      const target = resolve(source, value);
      if (!inside(source, target) || !existsSync(target) || !statSync(target).isFile()
        || !inside(root, realpathSync(target))) {
        throw new Error(`工作区包 exports 文件缺失或越界：${name} ${value}`);
      }
      if (!/\.(?:[cm]?js|[cm]?ts)$/u.test(target) || /\.c(?:js|ts)$/u.test(target)) {
        throw new Error(`工作区包 exports 必须使用 ESM 源码：${name} ${value}`);
      }
      // Current workspace APIs expose named exports. Refuse a new default API rather
      // than silently losing it in a facade; support can then be added deliberately.
      const text = readFileSync(target, "utf8");
      if (/\bexport\s+default\b|\bexport\s*\{[^}]*\bdefault\b/su.test(text)) {
        throw new Error(`工作区包默认导出需要显式注册支持：${name} ${value}`);
      }
      if (!targets.has(value)) {
        const filename = `entry-${targets.size}${value.endsWith(".d.ts") ? ".d.ts" : ".mjs"}`;
        let specifier = relative(destination, target).split(sep).join("/");
        if (!specifier.startsWith(".")) specifier = `./${specifier}`;
        files.push([filename, `// Canonical workspace source; do not relocate.\nexport * from ${JSON.stringify(specifier)};\n`]);
        targets.set(value, `./${filename}`);
      }
      return targets.get(value);
    };
    plans.push({ name, destination, files, manifest: { name, version: manifest.version, private: true, type: "module", exports: rewrite(manifest.exports) } });
  }
  for (const { destination, files, manifest } of plans) {
    const parent = dirname(destination);
    validateDestination(root, parent, "工作区注册目录");
    validateDestination(root, destination, "工作区注册目录");
    mkdirSync(parent, { recursive: true });
    if (!inside(root, realpathSync(parent))) throw new Error(`工作区注册目录越界：${parent}`);
    rmSync(destination, { force: true, recursive: true });
    mkdirSync(destination);
    writeFileSync(join(destination, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    for (const [filename, content] of files) writeFileSync(join(destination, filename), content);
  }
  return plans.map(({ name }) => name);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2]) throw new Error("用法：node scripts/pack-workspace-modules.mjs <runtime目录>");
    if (process.argv[2] === "--copy-sources") {
      if (!process.argv[3]) throw new Error("用法：pack-workspace-modules.mjs --copy-sources <runtime目录> <源码路径...>");
      const copied = copyRuntimeSources(process.cwd(), process.argv[3], process.argv.slice(4));
      console.log(`✓ 已复制 ${copied.length} 项载荷源码，未遍历开发依赖目录`);
    } else {
      const names = registerWorkspaceModules(process.argv[2]);
      console.log(`✓ ${names.length} 个工作区包已注册为实体 ESM 入口：${names.join(", ")}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
