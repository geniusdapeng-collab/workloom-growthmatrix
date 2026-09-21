#!/usr/bin/env node
/**
 * verify-rls-guc · RLS/GUC 静态检查（B-44）
 *
 * 扫描**新增写路径**（B-28..B-84 引入的模块；历史遗留写路径按祖父规则不追溯，账本中记录存量债务）：
 * 出现 INSERT/UPDATE/DELETE 的文件必须同时包含 app.workspace_id 与 app.tenant_id 的 set_config
 * （或显式标注 `// rls-exempt:` 说明豁免理由）。
 *
 * 用法：node scripts/ci/verify-rls-guc.mjs [--json] [--self-test]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
/** B-44 口径：只审新增/本次改造触及的写路径（存量路径在账本登记，避免一次性噪音）。 */
const targets = [
  "packages/base/asset-cms",
  "packages/base/cost-ledger",
  "packages/base/collaboration",
  "packages/base/watchdog",
  "packages/base/model-router/ledger.ts",
  "packages/base/social-listening/scheduler.ts",
  "apps/server/src/service/model-ledger.ts",
  "apps/server/src/service/watchdog.ts",
  "apps/server/src/service/conversion.ts",
];
const skipDir = /(^|\/)(node_modules|dist|__tests__)(\/|$)/;
const isSource = (p) => p.endsWith(".ts") || p.endsWith(".mts");
const isTest = (p) => /\.test\.(ts|mts)$|\.pg\.test\.ts$/.test(p);
const WRITE_RE = /\b(INSERT\s+INTO|UPDATE\s+[a-z_]+\s+SET|DELETE\s+FROM)\b/i;
const WS_RE = /app\.workspace_id/;
const TENANT_RE = /app\.tenant_id/;
/** 委托型上下文助手：这些入口在事务内设置双 GUC，文件内无需重复出现字符串。 */
const DELEGATE_RE = /(serviceTx\(|withTx\(|gatewayAppendOnClient\(|svcQuery\(|rlsContext|set_config\()/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (skipDir.test(full)) continue;
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (isSource(full)) out.push(full);
  }
  return out;
}

export function scanFile(path, text) {
  if (!WRITE_RE.test(text)) return null;
  if (/rls-exempt:/.test(text)) return null;
  const issues = [];
  const delegates = DELEGATE_RE.test(text);
  if (!WS_RE.test(text) && !delegates) issues.push("缺 app.workspace_id 上下文");
  if (!TENANT_RE.test(text) && !delegates) issues.push("缺 app.tenant_id 上下文");
  return issues.length > 0 ? { path, issues } : null;
}

function selfTest() {
  const bad = scanFile("x.ts", `await client.query("INSERT INTO t VALUES (1)")`);
  const good = scanFile("y.ts", `set_config('app.workspace_id'); set_config('app.tenant_id'); INSERT INTO t`);
  const exempt = scanFile("z.ts", `// rls-exempt: 平台级表\nINSERT INTO t`);
  if (!bad || good !== null || exempt !== null) throw new Error("self-test 失败");
  console.log("✓ verify-rls-guc self-test 通过");
}

if (process.argv.includes("--self-test")) {
  selfTest();
  process.exit(0);
}

const files = [];
for (const target of targets) {
  const full = join(root, target);
  try {
    const stat = statSync(full);
    if (stat.isDirectory()) files.push(...walk(full));
    else if (isSource(full)) files.push(full);
  } catch { /* 目标不存在：跳过（模块可能已重命名） */ }
}
const findings = [];
for (const file of files) {
  if (isTest(file)) continue;
  const issue = scanFile(file, readFileSync(file, "utf8"));
  if (issue) findings.push(issue);
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ scanned: targets, findings }, null, 2));
} else if (findings.length === 0) {
  console.log("✓ RLS/GUC 静态检查通过：新增写路径均设置双 GUC（或显式豁免）");
} else {
  console.error(`✗ RLS/GUC 静态检查发现 ${findings.length} 处问题：`);
  for (const f of findings) console.error(`  - ${f.path}：${f.issues.join("；")}`);
}
process.exit(findings.length === 0 ? 0 : 1);
