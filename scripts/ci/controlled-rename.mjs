#!/usr/bin/env node
/**
 * controlled-rename.mjs · 受控改名器与差异保留同步器（MC-008）
 *
 * 背景（为什么必须存在）：
 *   本仓是 `workloom-ai/WorkLoom-growth` 的隔离实验副本，按「整仓覆盖 + 全面改名」方式跟随上游。
 *   历史做法直接在上游工作树上批量替换标识，副作用有三个：
 *     ① 受控只读资产（`.workloom-base-sync.json#requiredRootAssetsSha256`）被一并改写，摘要漂移；
 *     ② 上轮施工单的自有改动（新增文件、有意差异）会被下一次整仓覆盖静默清零；
 *     ③ 改名结果不可复算：没人能回答「这 141 处内容差异里，哪些是改名、哪些是人为改动」。
 *
 *   本文件把同步收敛为「策略 + 复现 + 留痕」三段：
 *     · 策略：`.workloom-rename-policy.json` 声明内容规则 / 路径规则 / 受控资产 / 差异保留项；
 *     · 复现：同一份上游树 + 同一份策略必须复算出逐字节相同的目标树（classify 可复算比例）；
 *     · 留痕：plan/apply 产出 `workloom.rename-report/v1` 报告，逐文件记录动作与命中的规则。
 *
 * 三条硬纪律（代码强制，不靠自觉）：
 *   1. 受控资产永不改内容：命中 protectedAssets 的文件按上游原字节落盘，命中改名规则也不改写；
 *   2. 已登记差异永不覆盖：declaredDiffs 命中的目标文件保留本仓现有内容（preserved），只报告不动手；
 *   3. 未登记差异必须可见：目标树里既非改名可达、又未登记的差异一律计入 unexplained（--strict 失败）。
 *
 * 用法：
 *   node scripts/ci/controlled-rename.mjs plan     --source ../workloom-growth --target .
 *   node scripts/ci/controlled-rename.mjs apply    --source ../workloom-growth --target . --report outputs/sync/rename-report.json
 *   node scripts/ci/controlled-rename.mjs classify --source ../workloom-growth --target . --strict
 *   node scripts/ci/controlled-rename.mjs verify-assets
 *   node scripts/ci/controlled-rename.mjs describe
 *
 * 退出码：0 = 通过（可能有告警）；1 = 失败（未登记漂移 / 受控资产漂移 / 缺文件）；2 = 用法或输入错误。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const POLICY_SCHEMA = "workloom.rename-policy/v1";
export const REPORT_SCHEMA = "workloom.rename-report/v1";
export const DEFAULT_POLICY_PATH = ".workloom-rename-policy.json";
export const DEFAULT_BASE_SYNC_PATH = ".workloom-base-sync.json";

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

export function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

/** 路径一律转 POSIX 风格，避免 macOS/Windows 分隔符漂移导致比对假阳/假阴 */
export function toPosix(p) {
  return p.split(sep).join("/");
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 简化 glob：支持 `**`（跨目录）、`*`（单层）、`?`；大小写敏感。
 * 只覆盖本仓实际用到的形态（`**\/*.json`、`apps\/*\/src\/**`、`.git\/**`），不做完整 glob 语义。
 */
export function matchGlob(path, glob) {
  const target = toPosix(path);
  const pattern = toPosix(glob);
  let regex = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") {
      const isDouble = pattern[i + 1] === "*";
      if (isDouble) {
        const rest = pattern.slice(i + 2);
        if (rest.startsWith("/")) {
          regex += "(?:[^/]+/)*";
          i += 2;
        } else {
          regex += ".*";
          i += 1;
        }
      } else {
        regex += "[^/]*";
      }
    } else if (ch === "?") {
      regex += "[^/]";
    } else {
      regex += escapeRegExp(ch);
    }
  }
  regex += "$";
  return new RegExp(regex).test(target);
}

export function isExcluded(path, excludes) {
  const target = toPosix(path);
  return excludes.some((glob) => {
    const normalized = toPosix(glob);
    if (normalized.endsWith("/**")) {
      const prefix = normalized.slice(0, -3);
      if (target === prefix || target.startsWith(`${prefix}/`)) return true;
      if (prefix.startsWith("**/") && target.split("/").includes(prefix.slice(3))) return true;
    }
    return matchGlob(target, normalized);
  });
}

/**
 * 二进制判定：含 NUL 字节即视为二进制，一律按字节复制，绝不参与文本改名。
 * 理由：改名规则是面向文本标识的；对 PNG/字体/压缩包做正则替换会静默损坏资产。
 */
export function isBinaryBuffer(buffer) {
  return buffer.includes(0);
}

function ensureDir(path) {
  mkdirSync(dirname(path), { recursive: true });
}

/** 递归列出文件（相对路径 POSIX 风格）；不跟随符号链接，不进入 excluded */
export function walkFiles(root, { excludes = [] } = {}) {
  const out = [];
  const visit = (dir, prefix) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      throw new Error(`目录不可读：${dir}（${err instanceof Error ? err.message : String(err)}）`);
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (isExcluded(rel, excludes)) continue;
      const abs = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(abs, rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  };
  visit(root, "");
  return out.sort();
}

/* ------------------------------------------------------------------ */
/* 策略加载与校验                                                       */
/* ------------------------------------------------------------------ */

export function loadPolicy(repoRoot, policyPath = DEFAULT_POLICY_PATH) {
  const abs = resolve(repoRoot, policyPath);
  if (!existsSync(abs)) {
    throw new Error(`缺少改名策略：${abs}（预期 schema=${POLICY_SCHEMA}）`);
  }
  const policy = readJson(abs);
  return { policy, path: abs };
}

/**
 * 受控只读资产：来自 `.workloom-base-sync.json#requiredRootAssetsSha256`。
 * `#managed-section` 形态（如 `AGENTS.md#managed-section`）只锁片段，不锁整文件，单独返回。
 */
export function loadProtectedAssets(repoRoot, baseSyncPath = DEFAULT_BASE_SYNC_PATH) {
  const abs = resolve(repoRoot, baseSyncPath);
  if (!existsSync(abs)) {
    throw new Error(`缺少基座同步状态：${abs}`);
  }
  const state = readJson(abs);
  const digestMap = state.requiredRootAssetsSha256 ?? {};
  const files = new Map();
  const managedSections = [];
  for (const [key, digest] of Object.entries(digestMap)) {
    if (key.includes("#")) {
      const [file, section] = key.split("#");
      managedSections.push({ key, file, section, sha256: digest });
      continue;
    }
    files.set(key, digest);
  }
  return { files, managedSections, baseSyncPath: abs };
}

export function compileRule(rule) {
  if (rule.kind !== "content" && rule.kind !== "path") {
    throw new Error(`规则 ${rule.id} 的 kind 非法：${rule.kind}（只允许 content | path）`);
  }
  const flags = rule.flags ?? "g";
  return { ...rule, regex: new RegExp(rule.match, flags) };
}

export function validatePolicy(policy, { protectedAssets } = {}) {
  const errors = [];
  const warnings = [];
  if (policy?.schema !== POLICY_SCHEMA) {
    errors.push(`策略 schema 应为 ${POLICY_SCHEMA}，实际 ${policy?.schema ?? "(缺失)"}`);
  }
  const rules = policy?.rules;
  if (!Array.isArray(rules) || rules.length === 0) {
    errors.push("策略缺少 rules（内容/路径改名规则）");
  }
  const seenIds = new Set();
  const compiled = [];
  for (const [index, rule] of (rules ?? []).entries()) {
    const label = rule?.id ?? `rules[${index}]`;
    if (!rule?.id || typeof rule.id !== "string") errors.push(`${label} 缺少字符串 id`);
    if (seenIds.has(rule?.id)) errors.push(`规则 id 重复：${rule.id}`);
    seenIds.add(rule?.id);
    if (rule?.kind !== "content" && rule?.kind !== "path") errors.push(`${label} 的 kind 非法：${rule?.kind}`);
    if (!rule?.match || typeof rule.match !== "string") errors.push(`${label} 缺少 match 正则`);
    if (typeof rule?.replace !== "string") errors.push(`${label} 缺少 replace 字符串`);
    if (rule?.kind === "content" && !Array.isArray(rule?.scope)) {
      errors.push(`${label} 缺少 scope 数组（内容规则的生效范围）`);
    }
    if (!rule?.evidence) warnings.push(`${label} 未写 evidence（可追溯性下降）`);
    try {
      const compiledRule = compileRule(rule);
      if (!compiledRule.regex.global) warnings.push(`${label} 正则未带 g 标志，改名只会替换首个匹配`);
      compiled.push(compiledRule);
    } catch (err) {
      errors.push(`${label} 正则非法：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const declared = new Map();
  for (const entry of policy?.declaredDiffs ?? []) {
    if (!entry?.reason) errors.push(`declaredDiffs 条目缺少 reason：${JSON.stringify(entry).slice(0, 120)}`);
    if (!Array.isArray(entry?.paths) || entry.paths.length === 0) {
      errors.push(`declaredDiffs 条目缺少 paths：${entry?.reason ?? "(无 reason)"}`);
      continue;
    }
    if (!["added", "modified", "removed"].includes(entry.kind)) {
      errors.push(`declaredDiffs 条目 ${entry.reason} 的 kind 非法：${entry.kind}`);
    }
    for (const path of entry.paths) {
      if (declared.has(path)) warnings.push(`declaredDiffs 重复登记：${path}`);
      declared.set(path, entry);
    }
  }
  // 受控资产不得被任何规则改写：策略层拦截，避免「改名改到受控副本」再次发生
  if (protectedAssets?.files?.size) {
    for (const rule of compiled.filter((r) => r.kind === "content")) {
      const covered = [...protectedAssets.files.keys()].filter((assetPath) =>
        rule.scope.some((glob) => matchGlob(assetPath, glob)),
      );
      if (covered.length) {
        warnings.push(
          `规则 ${rule.id} 的 scope 覆盖 ${covered.length} 项受控资产（运行时按「受控优先」跳过，属预期；如需收窄 scope 见策略 contract）`,
        );
      }
    }
    for (const rule of compiled.filter((r) => r.kind === "path")) {
      for (const assetPath of protectedAssets.files.keys()) {
        const mapped = assetPath.replace(rule.regex, rule.replace);
        if (mapped !== assetPath) {
          errors.push(`路径规则 ${rule.id} 会改写受控资产路径：${assetPath} → ${mapped}`);
        }
      }
    }
  }
  return { errors, warnings, compiledRules: compiled, declaredDiffs: declared };
}

/* ------------------------------------------------------------------ */
/* 规则应用                                                            */
/* ------------------------------------------------------------------ */

export function applyContentRules(text, rules, path) {
  let out = text;
  const fired = [];
  for (const rule of rules) {
    if (rule.kind !== "content") continue;
    if (rule.scope?.length && !rule.scope.some((glob) => matchGlob(path, glob))) continue;
    rule.regex.lastIndex = 0;
    if (!rule.regex.test(out)) continue;
    rule.regex.lastIndex = 0;
    out = out.replace(rule.regex, rule.replace);
    fired.push(rule.id);
  }
  return { text: out, fired };
}

export function applyPathRules(path, rules) {
  let out = toPosix(path);
  const fired = [];
  for (const rule of rules) {
    if (rule.kind !== "path") continue;
    rule.regex.lastIndex = 0;
    if (!rule.regex.test(out)) continue;
    rule.regex.lastIndex = 0;
    const next = out.replace(rule.regex, rule.replace);
    if (next !== out) {
      out = next;
      fired.push(rule.id);
    }
  }
  return { path: out, fired };
}

/* ------------------------------------------------------------------ */
/* 同步计划 / 执行                                                      */
/* ------------------------------------------------------------------ */

function isProtected(rel, protectedAssets) {
  return protectedAssets?.files?.has(toPosix(rel)) ?? false;
}

/**
 * 生成同步计划（不写盘）。
 * 返回的 entries 覆盖「上游有 → 本仓应有」的全部文件；staleTargets 记录本仓存在但上游与策略都无法解释的文件。
 */
export function planSync({ sourceRoot, targetRoot, policy, protectedAssets }) {
  const excludes = policy.contract?.excludedPaths ?? [];
  const validation = validatePolicy(policy, { protectedAssets });
  const rules = validation.compiledRules;
  const declared = validation.declaredDiffs;
  const sourceFiles = walkFiles(sourceRoot, { excludes });
  const targetFiles = new Set(walkFiles(targetRoot, { excludes }));
  const entries = [];
  const mappedTargets = new Set();

  for (const rel of sourceFiles) {
    const pathResult = applyPathRules(rel, rules);
    const targetRel = pathResult.path;
    mappedTargets.add(targetRel);
    const sourceBuf = readFileSync(join(sourceRoot, rel));
    const binary = isBinaryBuffer(sourceBuf);
    const protectedAsset = isProtected(rel, protectedAssets) || isProtected(targetRel, protectedAssets);
    const declaration = declared.get(targetRel) ?? declared.get(rel);
    if (declaration?.kind === "removed") {
      entries.push({
        sourcePath: rel,
        targetPath: targetRel,
        action: "removed-declared",
        protected: false,
        binary,
        declared: declaration.reason,
        rules: pathResult.fired,
      });
      continue;
    }
    const existsInTarget = targetFiles.has(targetRel);

    let action;
    let fired = pathResult.fired;
    if (protectedAsset) {
      action = "protected";
    } else if (declaration && existsInTarget) {
      action = "preserved";
    } else if (binary) {
      action = pathResult.fired.length ? "path-renamed" : "copied";
    } else {
      const contentResult = applyContentRules(sourceBuf.toString("utf-8"), rules, targetRel);
      fired = [...pathResult.fired, ...contentResult.fired];
      action = contentResult.fired.length ? "rewritten" : pathResult.fired.length ? "path-renamed" : "copied";
    }
    entries.push({
      sourcePath: rel,
      targetPath: targetRel,
      action,
      protected: protectedAsset,
      binary,
      declared: declaration ? declaration.reason : null,
      rules: fired,
    });
  }

  const staleTargets = [...targetFiles]
    .filter((rel) => !mappedTargets.has(rel) && !declared.has(rel))
    .sort();
  const declaredMissing = [...declared.keys()].filter((rel) => !targetFiles.has(rel)).sort();
  const stats = {
    sourceFiles: sourceFiles.length,
    targetFiles: targetFiles.size,
    copied: entries.filter((e) => e.action === "copied").length,
    pathRenamed: entries.filter((e) => e.action === "path-renamed").length,
    rewritten: entries.filter((e) => e.action === "rewritten").length,
    protected: entries.filter((e) => e.action === "protected").length,
    preserved: entries.filter((e) => e.action === "preserved").length,
    removedDeclared: entries.filter((e) => e.action === "removed-declared").length,
    staleTargets: staleTargets.length,
    declaredMissing: declaredMissing.length,
  };
  return {
    entries,
    staleTargets,
    declaredMissing,
    stats,
    compiledRules: rules,
    errors: validation.errors,
    warnings: validation.warnings,
    protectedManifest: protectedAssets
      ? [...protectedAssets.files.keys()].sort()
      : [],
  };
}

/**
 * 落盘执行计划。默认 dry-run；`write: true` 才写文件。
 * 语义：受控资产按上游原字节、已登记差异保留本仓现字节、其余按规则改写。
 */
export function applyPlan(plan, { sourceRoot, targetRoot, write = false }) {
  const written = [];
  const preserved = [];
  const skipped = [];
  for (const entry of plan.entries) {
    const sourceAbs = join(sourceRoot, entry.sourcePath);
    const targetAbs = join(targetRoot, entry.targetPath);
    if (entry.action === "preserved") {
      preserved.push(entry.targetPath);
      continue;
    }
    if (entry.action === "removed-declared") {
      skipped.push(entry.targetPath);
      continue;
    }
    if (entry.action === "protected" || entry.binary) {
      const bytes = readFileSync(sourceAbs);
      if (write) {
        ensureDir(targetAbs);
        writeFileSync(targetAbs, bytes);
      }
      written.push({ path: entry.targetPath, action: entry.action, rules: [] });
      continue;
    }
    const sourceText = readFileSync(sourceAbs, "utf-8");
    const { text, fired } = applyContentRules(sourceText, plan.compiledRules ?? [], entry.targetPath);
    if (write) {
      ensureDir(targetAbs);
      writeFileSync(targetAbs, text);
    }
    written.push({ path: entry.targetPath, action: entry.action, rules: fired });
  }
  for (const stale of plan.staleTargets) skipped.push(stale);
  return { written, preserved, skipped, dryRun: !write };
}

/* ------------------------------------------------------------------ */
/* 差异分类（用于验证：同一上游树 + 同一策略能否复现本仓树）                 */
/* ------------------------------------------------------------------ */

export function classifyTrees({ sourceRoot, targetRoot, policy, protectedAssets }) {
  const excludes = policy.contract?.excludedPaths ?? [];
  const validation = validatePolicy(policy, { protectedAssets });
  const rules = validation.compiledRules;
  const declared = validation.declaredDiffs;
  const sourceFiles = walkFiles(sourceRoot, { excludes });
  const targetFiles = new Set(walkFiles(targetRoot, { excludes }));

  const renameExplained = [];
  const declaredPreserved = [];
  const declaredRemoved = [];
  const protectedIdentical = [];
  let identicalCount = 0;
  const protectedDrift = [];
  const unexplained = [];
  const missing = [];
  const mappedTargets = new Set();

  for (const rel of sourceFiles) {
    const { path: targetRel, fired: pathFired } = applyPathRules(rel, rules);
    mappedTargets.add(targetRel);
    if (!targetFiles.has(targetRel)) {
      // 有意删除：declaredDiffs 里登记 kind=removed 的上游文件允许在本仓不存在
      const declaration = declared.get(targetRel) ?? declared.get(rel);
      if (declaration?.kind === "removed") {
        declaredRemoved.push({ sourcePath: rel, targetPath: targetRel, reason: declaration.reason });
      } else {
        missing.push({ sourcePath: rel, targetPath: targetRel });
      }
      continue;
    }
    const sourceBuf = readFileSync(join(sourceRoot, rel));
    const targetBuf = readFileSync(join(targetRoot, targetRel));
    const identical = sourceBuf.equals(targetBuf);
    const protectedAsset = isProtected(rel, protectedAssets) || isProtected(targetRel, protectedAssets);

    if (protectedAsset) {
      if (identical) protectedIdentical.push(targetRel);
      else {
        protectedDrift.push({
          path: targetRel,
          expectedSha256: sha256(sourceBuf),
          actualSha256: sha256(targetBuf),
          drift: true,
        });
      }
      continue;
    }
    if (identical) {
      identicalCount += 1;
      continue;
    }

    if (isBinaryBuffer(sourceBuf)) {
      if (declared.has(targetRel) || declared.has(rel)) declaredPreserved.push(targetRel);
      else {
        unexplained.push({
          targetPath: targetRel,
          sourcePath: rel,
          rulesFired: pathFired,
          binary: true,
          sourceSha256: sha256(sourceBuf),
          targetSha256: sha256(targetBuf),
        });
      }
      continue;
    }

    const { text, fired } = applyContentRules(sourceBuf.toString("utf-8"), rules, targetRel);
    if (text === targetBuf.toString("utf-8")) {
      renameExplained.push({ targetPath: targetRel, rules: [...pathFired, ...fired] });
      continue;
    }
    if (declared.has(targetRel) || declared.has(rel)) {
      declaredPreserved.push(targetRel);
      continue;
    }
    unexplained.push({
      targetPath: targetRel,
      sourcePath: rel,
      rulesFired: [...pathFired, ...fired],
      sourceSha256: sha256(sourceBuf),
      targetSha256: sha256(targetBuf),
    });
  }

  const undeclaredNewFiles = [...targetFiles]
    .filter((rel) => !mappedTargets.has(rel) && !declared.has(rel))
    .sort();

  return {
    stats: {
      sourceFiles: sourceFiles.length,
      targetFiles: targetFiles.size,
      identical: identicalCount,
      renameExplained: renameExplained.length,
      declaredPreserved: declaredPreserved.length,
      declaredRemoved: declaredRemoved.length,
      protectedIdentical: protectedIdentical.length,
      unexplained: unexplained.length,
      protectedDrift: protectedDrift.length,
      missing: missing.length,
      undeclaredNewFiles: undeclaredNewFiles.length,
      reproducibleRatio:
        sourceFiles.length === 0
          ? "0/0"
          : `${identicalCount + renameExplained.length + declaredPreserved.length + declaredRemoved.length + protectedIdentical.length}/${sourceFiles.length}`,
    },
    renameExplained,
    declaredPreserved,
    declaredRemoved,
    protectedIdentical,
    protectedDrift,
    unexplained,
    missing,
    undeclaredNewFiles,
    errors: validation.errors,
    warnings: validation.warnings,
  };
}

/** 受控资产摘要核验（漂移必须为 0） */
export function verifyProtectedAssets({ repoRoot, protectedAssets }) {
  const drift = [];
  const missing = [];
  for (const [rel, expected] of protectedAssets.files.entries()) {
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) {
      missing.push({ path: rel, expectedSha256: expected });
      continue;
    }
    const actual = sha256(readFileSync(abs));
    if (actual !== expected) drift.push({ path: rel, expectedSha256: expected, actualSha256: actual });
  }
  return { drift, missing, total: protectedAssets.files.size };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const [, , command, ...rest] = argv;
  const flags = { _: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (!next || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i += 1;
      }
    } else {
      flags._.push(token);
    }
  }
  return { command, flags };
}

function buildReport({ command, policy, policyPath, sourceRoot, targetRoot, payload }) {
  return {
    schema: REPORT_SCHEMA,
    command,
    generatedAt: new Date().toISOString(),
    policy: { schema: policy.schema, path: policyPath },
    sourceRoot,
    targetRoot,
    ...payload,
  };
}

function printPlan(plan) {
  const s = plan.stats;
  console.log("[rename] 同步计划（dry-run）");
  console.log(`  上游文件 ${s.sourceFiles} · 本仓文件 ${s.targetFiles}`);
  console.log(
    `  动作：copied=${s.copied} path-renamed=${s.pathRenamed} rewritten=${s.rewritten} ` +
      `protected=${s.protected} preserved=${s.preserved} removed-declared=${s.removedDeclared}`,
  );
  console.log(`  未登记残留：staleTargets=${s.staleTargets} declaredMissing=${s.declaredMissing}`);
  for (const error of plan.errors) console.log(`  ✗ ${error}`);
  for (const warning of plan.warnings) console.log(`  ⚠ ${warning}`);
  if (plan.staleTargets.length) {
    console.log("  ⚠ 未登记的目标侧文件（不会被删除，需人工登记或清理）：");
    for (const path of plan.staleTargets.slice(0, 20)) console.log(`    - ${path}`);
    if (plan.staleTargets.length > 20) console.log(`    …（其余 ${plan.staleTargets.length - 20} 项见报告）`);
  }
}

function main() {
  const { command, flags } = parseArgs(process.argv);
  const repoRoot = resolve(String(flags.repo ?? process.cwd()));
  const policyPath = String(flags.policy ?? DEFAULT_POLICY_PATH);
  const json = Boolean(flags.json);
  const strict = Boolean(flags.strict);

  try {
    if (!command || command === "help" || command === "--help") {
      console.log(
        [
          "受控改名器（workloom.rename-policy/v1）",
          "  plan          生成同步计划（dry-run，不写盘）",
          "  apply         执行同步（受控资产原字节 / 已登记差异保留 / 其余按规则改写）",
          "  classify      对已存在的两棵树做差异分类（验证可复现性）",
          "  verify-assets 只校验受控资产摘要漂移",
          "  describe      打印策略规则与登记项清单",
          "",
          "公共参数：--repo <仓库根> --policy <策略路径> --source <上游工作树> --target <目标树> --json --strict",
          "apply 额外参数：--write 真正落盘（缺省 dry-run）--report <报告路径>",
        ].join("\n"),
      );
      return 0;
    }

    const { policy } = loadPolicy(repoRoot, policyPath);
    const protectedAssets = loadProtectedAssets(repoRoot);
    const validation = validatePolicy(policy, { protectedAssets });

    if (command === "describe") {
      const content = validation.compiledRules.filter((r) => r.kind === "content");
      const paths = validation.compiledRules.filter((r) => r.kind === "path");
      const output = {
        schema: policy.schema,
        identity: policy.identity,
        contract: policy.contract,
        contentRules: content.map((r) => ({ id: r.id, match: r.match, replace: r.replace, scope: r.scope })),
        pathRules: paths.map((r) => ({ id: r.id, match: r.match, replace: r.replace })),
        declaredDiffs: (policy.declaredDiffs ?? []).map((e) => ({ reason: e.reason, task: e.task, kind: e.kind, paths: e.paths })),
        protectedAssets: [...protectedAssets.files.keys()],
        protectedManagedSections: protectedAssets.managedSections.map((s) => s.key),
        errors: validation.errors,
        warnings: validation.warnings,
      };
      console.log(json ? JSON.stringify(output, null, 2) : formatDescribe(output));
      return validation.errors.length ? 1 : 0;
    }

    if (command === "verify-assets") {
      const result = verifyProtectedAssets({ repoRoot, protectedAssets });
      if (json) {
        console.log(JSON.stringify({ schema: REPORT_SCHEMA, command, generatedAt: new Date().toISOString(), ...result }, null, 2));
      } else {
        console.log(`[rename] 受控资产 ${result.total} 项：漂移 ${result.drift.length} · 缺失 ${result.missing.length}`);
        for (const item of result.drift) console.log(`  ✗ ${item.path}（期望 ${item.expectedSha256.slice(0, 12)}… 实际 ${item.actualSha256.slice(0, 12)}…）`);
        for (const item of result.missing) console.log(`  ✗ 缺失 ${item.path}`);
      }
      return result.drift.length + result.missing.length ? 1 : 0;
    }

    const sourceRoot = flags.source ? resolve(String(flags.source)) : null;
    const targetRoot = resolve(String(flags.target ?? repoRoot));
    if (command === "plan" || command === "apply" || command === "classify") {
      if (!sourceRoot) throw new Error(`${command} 需要 --source <上游工作树>（例如 ../workloom-growth 的 checkout）`);
      if (!existsSync(sourceRoot)) throw new Error(`上游工作树不存在：${sourceRoot}`);
      if (!existsSync(targetRoot)) throw new Error(`目标树不存在：${targetRoot}`);
    }

    if (command === "plan" || command === "apply") {
      const plan = planSync({ sourceRoot, targetRoot, policy, protectedAssets });
      const write = command === "apply" && Boolean(flags.write);
      const outcome = command === "apply" ? applyPlan(plan, { sourceRoot, targetRoot, write }) : null;
      const report = buildReport({
        command,
        policy,
        policyPath,
        sourceRoot,
        targetRoot,
        payload: {
          dryRun: command === "plan" ? true : !write,
          stats: plan.stats,
          entries: plan.entries.map(({ content, ...rest }) => rest),
          staleTargets: plan.staleTargets,
          declaredMissing: plan.declaredMissing,
          outcome,
          errors: plan.errors,
          warnings: plan.warnings,
        },
      });
      if (flags.report) {
        const reportPath = resolve(String(flags.report));
        ensureDir(reportPath);
        writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
        console.log(`[rename] 报告已写入 ${reportPath}`);
      }
      if (json) console.log(JSON.stringify(report, null, 2));
      else printPlan(plan);
      const failed = plan.errors.length > 0 || (strict && (plan.staleTargets.length > 0 || plan.declaredMissing.length > 0));
      return failed ? 1 : 0;
    }

    if (command === "classify") {
      const result = classifyTrees({ sourceRoot, targetRoot, policy, protectedAssets });
      const report = buildReport({
        command,
        policy,
        policyPath,
        sourceRoot,
        targetRoot,
        payload: { dryRun: true, ...result },
      });
      if (flags.snippet) {
        // 供同步操作者把未登记差异粘贴进策略：按「修改 / 新增 / 删除」分组
        const task = String(flags["snippet-task"] ?? "T-YYYY-MMDD-NNNN");
        const groups = [];
        if (result.unexplained.length) {
          groups.push({
            reason: `${task} · 本轮有意修改（未登记差异，登记前请逐项确认是否为改名遗漏）`,
            task,
            kind: "modified",
            paths: result.unexplained.map((item) => item.targetPath).sort(),
          });
        }
        if (result.undeclaredNewFiles.length) {
          groups.push({ reason: `${task} · 本轮新增文件（上游不存在）`, task, kind: "added", paths: result.undeclaredNewFiles });
        }
        if (result.missing.length) {
          groups.push({
            reason: `${task} · 本轮有意删除（上游存在、本仓不再保留）`,
            task,
            kind: "removed",
            paths: result.missing.map((item) => item.targetPath).sort(),
          });
        }
        console.log(JSON.stringify(groups, null, 2));
        return 0;
      }
      if (flags.report) {
        const reportPath = resolve(String(flags.report));
        ensureDir(reportPath);
        writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      }
      if (json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        const s = result.stats;
        console.log("[rename] 差异分类");
        console.log(`  上游 ${s.sourceFiles} 文件 → 可复现 ${s.reproducibleRatio}（逐字节一致 ${s.identical}）`);
        console.log(
          `  改名可复现 ${s.renameExplained} · 已登记差异 ${s.declaredPreserved} · 已登记删除 ${s.declaredRemoved} · 受控资产一致 ${s.protectedIdentical}`,
        );
        console.log(
          `  未登记差异 ${s.unexplained} · 受控漂移 ${s.protectedDrift} · 缺文件 ${s.missing} · 未登记新增 ${s.undeclaredNewFiles}`,
        );
        for (const item of result.unexplained.slice(0, 20)) console.log(`  ✗ 未登记差异 ${item.targetPath}`);
        for (const item of result.protectedDrift.slice(0, 20)) console.log(`  ✗ 受控漂移 ${item.path}`);
        for (const item of result.missing.slice(0, 20)) console.log(`  ✗ 上游文件在本仓缺失 ${item.targetPath}`);
        for (const path of result.undeclaredNewFiles.slice(0, 20)) console.log(`  ⚠ 未登记新增 ${path}`);
      }
      const blocking =
        result.errors.length > 0 || result.protectedDrift.length > 0 || result.missing.length > 0 ||
        (strict && (result.unexplained.length > 0 || result.undeclaredNewFiles.length > 0));
      return blocking ? 1 : 0;
    }

    console.error(`未知子命令：${command}（可用 plan | apply | classify | verify-assets | describe）`);
    return 2;
  } catch (err) {
    console.error(`[rename] 失败：${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}

function formatDescribe(output) {
  const lines = [];
  lines.push(`[rename] 策略 ${output.schema} · ${output.identity?.repository ?? "?"} ← ${output.identity?.upstreamRepository ?? "?"}@${output.identity?.upstreamRef ?? "?"}`);
  lines.push(`  内容规则 ${output.contentRules.length} 条：`);
  for (const rule of output.contentRules) lines.push(`    - ${rule.id}：${rule.match} → ${rule.replace}`);
  lines.push(`  路径规则 ${output.pathRules.length} 条：`);
  for (const rule of output.pathRules) lines.push(`    - ${rule.id}：${rule.match} → ${rule.replace}`);
  lines.push(`  差异保留登记 ${output.declaredDiffs.length} 组：`);
  for (const entry of output.declaredDiffs) lines.push(`    - [${entry.task}] ${entry.reason}（${entry.paths.length} 项）`);
  lines.push(`  受控资产 ${output.protectedAssets.length} 项（含 ${output.protectedManagedSections.length} 个片段级）`);
  for (const warning of output.warnings) lines.push(`  ⚠ ${warning}`);
  for (const error of output.errors) lines.push(`  ✗ ${error}`);
  return lines.join("\n");
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exitCode = main();
}
