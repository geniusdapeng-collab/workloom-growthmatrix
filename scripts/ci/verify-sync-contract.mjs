#!/usr/bin/env node
/**
 * verify-sync-contract.mjs · 受控改名与差异保留同步契约门禁（MC-008）
 *
 * 回答四个问题（与 `.workloom-rename-policy.json` 同源）：
 *   ① 受控只读资产是否零漂移？（`.workloom-base-sync.json#requiredRootAssetsSha256` 逐项复算）
 *   ② 改名策略是否自洽？（规则 id/正则/scope 合法；路径规则不得改写受控资产路径）
 *   ③ 差异保留登记是否有效？（declaredDiffs 覆盖的路径必须真实存在，除非登记为 removed）
 *   ④ 上游树 → 本仓树的可复现比例是多少？（给出 `--source` 时逐文件复算，`--strict` 下未登记差异失败）
 *
 * 用法：
 *   node scripts/ci/verify-sync-contract.mjs                          # CI 常态：① ② ③
 *   node scripts/ci/verify-sync-contract.mjs --source ../workloom-growth --strict   # 同步操作：追加 ④ 且未登记差异失败
 *   node scripts/ci/verify-sync-contract.mjs --json --report outputs/sync/sync-contract.json
 *
 * 退出码：0 = 通过（可能有告警）；1 = 失败；2 = 输入错误（缺策略/上游树不存在等）。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_POLICY_PATH,
  classifyTrees,
  loadPolicy,
  loadProtectedAssets,
  validatePolicy,
  verifyProtectedAssets,
} from "./controlled-rename.mjs";

function parseArgs(argv) {
  const flags = { _: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i += 1;
      }
    } else {
      flags._.push(token);
    }
  }
  return flags;
}

function main() {
  const flags = parseArgs(process.argv);
  const repoRoot = resolve(String(flags.repo ?? process.cwd()));
  const policyPath = String(flags.policy ?? DEFAULT_POLICY_PATH);
  const json = Boolean(flags.json);
  const strict = Boolean(flags.strict);
  const failures = [];
  const warnings = [];

  let policy;
  let protectedAssets;
  try {
    ({ policy } = loadPolicy(repoRoot, policyPath));
    protectedAssets = loadProtectedAssets(repoRoot);
  } catch (err) {
    console.error(`[sync-contract] 输入错误：${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  /* ① 受控资产摘要 */
  const assets = verifyProtectedAssets({ repoRoot, protectedAssets });
  if (assets.drift.length) {
    failures.push(`受控资产摘要漂移 ${assets.drift.length} 项（改名前必须与上游逐字节一致）`);
  }
  if (assets.missing.length) {
    failures.push(`受控资产缺失 ${assets.missing.length} 项`);
  }

  /* ② 策略自洽 */
  const validation = validatePolicy(policy, { protectedAssets });
  failures.push(...validation.errors);
  warnings.push(...validation.warnings);

  /* ③ 差异保留登记有效性 */
  const declaredEntries = policy.declaredDiffs ?? [];
  const declaredPaths = new Set(declaredEntries.flatMap((entry) => entry.paths ?? []));
  const declaredAbsent = [];
  for (const entry of declaredEntries) {
    if (entry.kind === "removed") continue;
    for (const path of entry.paths ?? []) {
      if (!existsSync(join(repoRoot, path))) declaredAbsent.push({ path, reason: entry.reason });
    }
  }
  if (declaredAbsent.length) {
    failures.push(
      `差异保留登记指向不存在的文件 ${declaredAbsent.length} 项（登记过期或路径写错）：` +
        declaredAbsent
          .slice(0, 5)
          .map((item) => item.path)
          .join("、"),
    );
  }
  // 登记项不得与受控资产重叠（受控资产必须与上游一致，不属于「有意差异」）
  const declaredOnProtected = [...declaredPaths].filter((path) => protectedAssets.files.has(path));
  if (declaredOnProtected.length) {
    failures.push(`差异保留登记与受控资产重叠：${declaredOnProtected.join("、")}（受控资产不允许有意差异）`);
  }

  /* ④ 上游树 → 本仓树复现（可选） */
  const sourceFlag = flags.source ? resolve(String(flags.source)) : null;
  let classification = null;
  if (sourceFlag) {
    if (!existsSync(sourceFlag)) {
      console.error(`[sync-contract] 上游工作树不存在：${sourceFlag}`);
      return 2;
    }
    classification = classifyTrees({ sourceRoot: sourceFlag, targetRoot: repoRoot, policy, protectedAssets });
    if (classification.protectedDrift.length) {
      failures.push(`受控资产与上游不一致 ${classification.protectedDrift.length} 项`);
    }
    if (classification.missing.length) {
      failures.push(`上游文件在本仓缺失 ${classification.missing.length} 项（同步会丢文件）`);
    }
    if (strict) {
      if (classification.unexplained.length) {
        failures.push(`未登记差异 ${classification.unexplained.length} 项（--strict：必须先登记或收窄规则）`);
      }
      if (classification.undeclaredNewFiles.length) {
        failures.push(`未登记新增文件 ${classification.undeclaredNewFiles.length} 项`);
      }
    } else if (classification.unexplained.length || classification.undeclaredNewFiles.length) {
      warnings.push(
        `存在未登记差异 ${classification.unexplained.length} 项 / 未登记新增 ${classification.undeclaredNewFiles.length} 项（同步时请用 --strict 拦截）`,
      );
    }
  }

  const report = {
    schema: "workloom.sync-contract-report/v1",
    generatedAt: new Date().toISOString(),
    repoRoot,
    policy: { schema: policy.schema, path: policyPath, rules: validation.compiledRules.length, declaredPaths: declaredPaths.size },
    protectedAssets: {
      total: assets.total,
      drift: assets.drift,
      missing: assets.missing,
      managedSections: protectedAssets.managedSections.map((s) => s.key),
    },
    declaredAbsent,
    classification: classification
      ? {
          stats: classification.stats,
          unexplained: classification.unexplained,
          undeclaredNewFiles: classification.undeclaredNewFiles,
          protectedDrift: classification.protectedDrift,
          missing: classification.missing,
        }
      : null,
    failures,
    warnings,
  };

  if (flags.report) {
    const reportPath = resolve(String(flags.report));
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("[sync-contract] 受控改名与差异保留同步契约");
    console.log(
      `  ① 受控资产 ${assets.total} 项：漂移 ${assets.drift.length} · 缺失 ${assets.missing.length}` +
        `（片段级 ${protectedAssets.managedSections.length} 个）`,
    );
    console.log(`  ② 策略校验：规则 ${validation.compiledRules.length} 条 · 差异登记 ${declaredPaths.size} 项 · 错误 ${validation.errors.length}`);
    console.log(`  ③ 登记有效性：缺失目标 ${declaredAbsent.length} 项 · 与受控资产重叠 ${declaredOnProtected.length} 项`);
    if (classification) {
      const s = classification.stats;
      console.log(
        `  ④ 可复现性：${s.reproducibleRatio}（改名 ${s.renameExplained} · 登记差异 ${s.declaredPreserved} · 受控一致 ${s.protectedIdentical}）`,
      );
      console.log(
        `     未登记差异 ${s.unexplained} · 未登记新增 ${s.undeclaredNewFiles} · 受控漂移 ${s.protectedDrift} · 缺文件 ${s.missing}`,
      );
    } else {
      console.log("  ④ 可复现性：未提供 --source（同步操作必须追加 `--source <上游工作树> --strict`）");
    }
    for (const warning of warnings) console.log(`  ⚠ ${warning}`);
    for (const failure of failures) console.log(`  ✗ ${failure}`);
    console.log(failures.length ? "[sync-contract] 失败：先修复上述问题再同步" : "[sync-contract] 通过");
  }
  return failures.length ? 1 : 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exitCode = main();
}

export { main as runSyncContractCheck, parseArgs as parseSyncContractArgs };
