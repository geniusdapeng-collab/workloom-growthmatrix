/**
 * controlled-rename.test.mjs · 受控改名器与差异保留同步契约的单元/端到端回归（MC-008）
 *
 * 覆盖的四条硬纪律：
 *   ① 受控资产永不改内容（即使命中改名规则）；
 *   ② 已登记差异永不覆盖（preserved）；
 *   ③ 未登记差异必须可见（classify 报告 + --strict 非零退出）；
 *   ④ 同一上游树 + 同一策略可复算（含路径改名 / 内容改写 / 二进制原字节复制）。
 *
 * 用法：node --test scripts/ci/controlled-rename.test.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  applyPlan,
  classifyTrees,
  isBinaryBuffer,
  isExcluded,
  loadProtectedAssets,
  matchGlob,
  planSync,
  sha256,
  validatePolicy,
  verifyProtectedAssets,
} from "./controlled-rename.mjs";

const SCRIPT = fileURLToPath(new URL("./controlled-rename.mjs", import.meta.url));

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/**
 * 构造一组最小夹具：
 *   source/  上游树（含受控资产、需改名的行业目录、二进制资产）
 *   target/  本仓树（含已登记差异的本地改动）
 *   repo/    策略与基座同步状态（.workloom-rename-policy.json / .workloom-base-sync.json）
 */
function fixture({ extraRules = [], declaredPaths = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rename-fixture-"));
  const source = join(root, "source");
  const target = join(root, "target");
  const repo = join(root, "repo");

  // 上游树
  write(join(source, "docs/CONTROLLED.md"), "# 受控副本\n\n上游原文，含 geo-growth 字样与 workloom-growth 字样\n");
  write(join(source, "bundles/geo-growth/bundle.json"), '{"id":"geo-growth","repo":"workloom-ai/WorkLoom-growth"}\n');
  write(join(source, "packages/base/readme.md"), "包名 workloom-growth，行业包 bundles/geo-growth\n");
  write(join(source, "assets/logo.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x67, 0x65, 0x6f, 0x2d, 0x67, 0x72, 0x6f, 0x77, 0x74, 0x68, 0x00]));

  // 本仓树（已同步状态：受控资产与上游一致、行业目录已改名、已登记差异保留本地改动）
  write(join(target, "docs/CONTROLLED.md"), readFileSync(join(source, "docs/CONTROLLED.md")));
  write(join(target, "bundles/geo-growthmatrix/bundle.json"), '{"id":"geo-growthmatrix","repo":"workloom-ai/WorkLoom-growthmatrix"}\n');
  write(join(target, "packages/base/readme.md"), "包名 workloom-growthmatrix，行业包 bundles/geo-growthmatrix\n");
  write(join(target, "assets/logo.bin"), readFileSync(join(source, "assets/logo.bin")));
  for (const path of declaredPaths) {
    write(join(target, path), `本地有意改动：${path}\n`);
  }

  const controlledText = "受控副本占位（仓库根同名文件；摘要登记源为 .workloom-base-sync.json）\n";
  write(join(repo, "docs/CONTROLLED.md"), controlledText);
  write(
    join(repo, ".workloom-base-sync.json"),
    `${JSON.stringify(
      {
        baseRepo: "workloom-ai/workloom-im",
        lastSyncedBaseSha: "fixture",
        lastRequiredAssetsBaseSha: "fixture",
        requiredRootAssetsSha256: { "docs/CONTROLLED.md": sha256(Buffer.from(controlledText)) },
      },
      null,
      2,
    )}\n`,
  );
  const policy = {
    schema: "workloom.rename-policy/v1",
    identity: { repository: "workloom-ai/WorkLoom-growthmatrix", upstreamRepository: "workloom-ai/WorkLoom-growth", upstreamRef: "fixture", lane: "isolated-copy" },
    contract: {
      statement: "夹具：受控资产 + 登记差异 + 改名规则",
      protectedAssetsSource: ".workloom-base-sync.json#requiredRootAssetsSha256",
      excludedPaths: ["**/node_modules/**", ".git/**", "outputs/**"],
    },
    rules: [
      {
        id: "content.repo",
        kind: "content",
        match: "workloom-ai\\/WorkLoom-growth(?!matrix)",
        replace: "workloom-ai/WorkLoom-growthmatrix",
        scope: ["**/*"],
      },
      {
        id: "content.industry",
        kind: "content",
        match: "geo-growth(?!matrix)",
        replace: "geo-growthmatrix",
        scope: ["**/*"],
      },
      {
        id: "content.package",
        kind: "content",
        match: "workloom-growth(?!matrix)",
        replace: "workloom-growthmatrix",
        scope: ["**/*"],
      },
      { id: "path.bundle", kind: "path", match: "(^|\\/)bundles\\/geo-growth\\/", replace: "$1bundles/geo-growthmatrix/" },
      ...extraRules,
    ],
    declaredDiffs: declaredPaths.map((path) => ({
      reason: `夹具登记：${path}`,
      task: "T-FIXTURE",
      kind: "modified",
      paths: [path],
    })),
  };
  write(join(repo, ".workloom-rename-policy.json"), `${JSON.stringify(policy, null, 2)}\n`);

  return { root, source, target, repo, policy };
}

describe("glob 与排除规则", () => {
  it("支持 ** 跨目录与单层 *", () => {
    assert.equal(matchGlob("a/b/c.json", "**/*.json"), true);
    assert.equal(matchGlob("c.json", "**/*.json"), true);
    assert.equal(matchGlob("a/b/c.ts", "**/*.json"), false);
    assert.equal(matchGlob("apps/web/dist/index.html", "apps/*/dist/**"), true);
    assert.equal(matchGlob("build/entitlements.mac.plist", "apps/*/dist/**"), false);
  });

  it("node_modules 任意深度都被排除，构建产物目录按仓内实际形态排除", () => {
    const excludes = ["**/node_modules/**", ".git/**", "outputs/**", "apps/*/dist/**"];
    assert.equal(isExcluded("apps/web/node_modules/pg/index.js", excludes), true);
    assert.equal(isExcluded("node_modules/", excludes), true);
    assert.equal(isExcluded(".git/config", excludes), true);
    assert.equal(isExcluded("outputs/sync/rename-report.json", excludes), true);
    assert.equal(isExcluded("apps/web/dist/index.html", excludes), true);
    assert.equal(isExcluded("build/entitlements.mac.plist", excludes), false);
  });

  it("二进制判定基于 NUL 字节", () => {
    assert.equal(isBinaryBuffer(Buffer.from([0, 1, 2])), true);
    assert.equal(isBinaryBuffer(Buffer.from("plain text", "utf-8")), false);
  });
});

describe("策略校验", () => {
  it("路径规则改写受控资产路径时判为错误", () => {
    const { policy } = fixture();
    const protectedAssets = { files: new Map([["docs/CONTROLLED.md", "deadbeef"]]), managedSections: [] };
    const withPathRule = {
      ...policy,
      rules: [
        ...policy.rules,
        { id: "path.controlled", kind: "path", match: "docs\\/", replace: "docs-v2/" },
      ],
    };
    const { errors } = validatePolicy(withPathRule, { protectedAssets });
    assert.ok(errors.some((error) => error.includes("会改写受控资产路径")), errors.join("; "));
  });

  it("内容规则允许覆盖受控资产路径（运行时按受控优先跳过），仅告警", () => {
    const { policy } = fixture();
    const protectedAssets = { files: new Map([["docs/CONTROLLED.md", "deadbeef"]]), managedSections: [] };
    const { errors, warnings } = validatePolicy(policy, { protectedAssets });
    assert.deepEqual(errors, []);
    assert.ok(warnings.some((warning) => warning.includes("受控资产")));
  });

  it("规则缺 id/正则非法时判为错误", () => {
    const { policy } = fixture();
    const broken = { ...policy, rules: [{ kind: "content", match: "(", replace: "x", scope: ["**/*"] }] };
    const { errors } = validatePolicy(broken);
    assert.ok(errors.some((error) => error.includes("缺少字符串 id")));
    assert.ok(errors.some((error) => error.includes("正则非法")));
  });
});

describe("受控资产与差异保留", () => {
  it("受控资产命中改名规则也不改写：plan 标 protected，apply 保持上游原字节", () => {
    const { source, target, repo, policy } = fixture();
    const protectedAssets = loadProtectedAssets(repo);
    assert.ok(protectedAssets.files.has("docs/CONTROLLED.md"));
    const plan = planSync({ sourceRoot: source, targetRoot: target, policy, protectedAssets });
    const entry = plan.entries.find((item) => item.targetPath === "docs/CONTROLLED.md");
    assert.equal(entry.action, "protected");
    // 上游文件含改名 token，但受控资产必须原字节落盘（含 geo-growth / workloom-growth 原样）
    const scratch = mkdtempSync(join(tmpdir(), "rename-apply-"));
    write(join(scratch, "docs/CONTROLLED.md"), "被污染的内容 geo-growth\n");
    applyPlan(plan, { sourceRoot: source, targetRoot: scratch, write: true });
    assert.equal(
      readFileSync(join(scratch, "docs/CONTROLLED.md"), "utf-8"),
      readFileSync(join(source, "docs/CONTROLLED.md"), "utf-8"),
    );
  });

  it("已登记差异保留本仓内容，不被上游覆盖", () => {
    const declared = "bundles/geo-growthmatrix/bundle.json";
    const { source, target, repo, policy } = fixture({ declaredPaths: [declared] });
    const protectedAssets = loadProtectedAssets(repo);
    const plan = planSync({ sourceRoot: source, targetRoot: target, policy, protectedAssets });
    const entry = plan.entries.find((item) => item.targetPath === declared);
    assert.equal(entry.action, "preserved");
    const before = readFileSync(join(target, declared), "utf-8");
    applyPlan(plan, { sourceRoot: source, targetRoot: target, write: true });
    assert.equal(readFileSync(join(target, declared), "utf-8"), before);
  });

  it("二进制资产按原字节复制，不参与文本改写", () => {
    const { source, target, repo, policy } = fixture();
    const protectedAssets = loadProtectedAssets(repo);
    const plan = planSync({ sourceRoot: source, targetRoot: target, policy, protectedAssets });
    const entry = plan.entries.find((item) => item.targetPath === "assets/logo.bin");
    assert.equal(entry.binary, true);
    assert.equal(entry.action, "copied");
  });

  it("受控资产摘要漂移被检出", () => {
    const { repo } = fixture();
    const protectedAssets = loadProtectedAssets(repo);
    write(join(repo, "docs/CONTROLLED.md"), "被改过的受控资产\n");
    const result = verifyProtectedAssets({ repoRoot: repo, protectedAssets });
    assert.equal(result.drift.length, 1);
    assert.equal(result.drift[0].path, "docs/CONTROLLED.md");
  });
});

describe("差异分类与可复现性", () => {
  it("夹具内可复现比例 100%，未登记差异为 0", () => {
    const { source, target, repo, policy } = fixture();
    const protectedAssets = loadProtectedAssets(repo);
    const result = classifyTrees({ sourceRoot: source, targetRoot: target, policy, protectedAssets });
    assert.equal(result.stats.unexplained, 0);
    assert.equal(result.stats.protectedDrift, 0);
    assert.equal(result.stats.missing, 0);
    assert.equal(result.stats.reproducibleRatio, `${result.stats.sourceFiles}/${result.stats.sourceFiles}`);
  });

  it("未登记差异被识别，strict CLI 非零退出，非 strict 退出 0", () => {
    const { source, target, repo } = fixture();
    // 制造一处未登记的人为差异：上游文件存在、目标同路径内容不同且规则无法复现
    write(join(source, "packages/base/extra.md"), "上游原文\n");
    write(join(target, "packages/base/extra.md"), "本地未登记改动\n");

    const strictRun = () =>
      execFileSync(process.execPath, [SCRIPT, "classify", "--repo", repo, "--source", source, "--target", target, "--strict"], {
        encoding: "utf-8",
      });
    assert.throws(strictRun, (error) => error.status === 1);
    const lenient = execFileSync(
      process.execPath,
      [SCRIPT, "classify", "--repo", repo, "--source", source, "--target", target],
      { encoding: "utf-8" },
    );
    assert.match(lenient, /未登记差异 1/);
  });

  it("未登记新增文件在 strict 下失败", () => {
    const { source, target, repo } = fixture();
    write(join(target, "scripts/local-only.mjs"), "export const local = true;\n");
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [SCRIPT, "classify", "--repo", repo, "--source", source, "--target", target, "--strict"],
          { encoding: "utf-8" },
        ),
      (error) => error.status === 1,
    );
  });

  it("plan 报告含动作分类且不写盘（dry-run）", () => {
    const { source, target, repo } = fixture();
    const reportPath = join(repo, "outputs/sync/plan.json");
    execFileSync(
      process.execPath,
      [SCRIPT, "plan", "--repo", repo, "--source", source, "--target", target, "--report", reportPath],
      { encoding: "utf-8" },
    );
    const report = JSON.parse(readFileSync(reportPath, "utf-8"));
    assert.equal(report.schema, "workloom.rename-report/v1");
    assert.equal(report.dryRun, true);
    assert.ok(report.stats.rewritten >= 1);
    assert.ok(existsSync(join(repo, ".workloom-rename-policy.json")));
    // dry-run 不落盘：目标侧原本不存在的上游文件不应被创建
    write(join(source, "scripts/fresh.mjs"), "export const fresh = 'geo-growth';\n");
    execFileSync(
      process.execPath,
      [SCRIPT, "plan", "--repo", repo, "--source", source, "--target", target],
      { encoding: "utf-8" },
    );
    assert.equal(existsSync(join(target, "scripts/fresh.mjs")), false);
  });

  it("已登记删除（kind=removed）不算缺失，且同步不会把文件写回", () => {
    const { source, target, repo } = fixture();
    // 上游有 docs/legacy.md，本仓已按任务卡删除
    write(join(source, "docs/legacy.md"), "历史文档 geo-growth\n");
    const policyPath = join(repo, ".workloom-rename-policy.json");
    const policy = JSON.parse(readFileSync(policyPath, "utf-8"));
    policy.declaredDiffs.push({
      reason: "夹具登记：本轮有意删除 docs/legacy.md",
      task: "T-FIXTURE",
      kind: "removed",
      paths: ["docs/legacy.md"],
    });
    write(policyPath, `${JSON.stringify(policy, null, 2)}\n`);

    const protectedAssets = loadProtectedAssets(repo);
    const result = classifyTrees({ sourceRoot: source, targetRoot: target, policy, protectedAssets });
    assert.equal(result.stats.missing, 0);
    assert.equal(result.stats.declaredRemoved, 1);

    const plan = planSync({ sourceRoot: source, targetRoot: target, policy, protectedAssets });
    const entry = plan.entries.find((item) => item.sourcePath === "docs/legacy.md");
    assert.equal(entry.action, "removed-declared");
    applyPlan(plan, { sourceRoot: source, targetRoot: target, write: true });
    assert.equal(existsSync(join(target, "docs/legacy.md")), false);
  });

  it("--snippet 输出可直接粘贴的登记片段", () => {
    const { source, target, repo } = fixture();
    write(join(source, "packages/base/extra.md"), "上游原文\n");
    write(join(target, "packages/base/extra.md"), "本地未登记改动\n");
    write(join(target, "scripts/local-only.mjs"), "export const local = true;\n");
    const out = execFileSync(
      process.execPath,
      [SCRIPT, "classify", "--repo", repo, "--source", source, "--target", target, "--snippet", "--snippet-task", "T-2026-0929-0002"],
      { encoding: "utf-8" },
    );
    const groups = JSON.parse(out);
    const modified = groups.find((group) => group.kind === "modified");
    const added = groups.find((group) => group.kind === "added");
    assert.equal(modified.task, "T-2026-0929-0002");
    assert.ok(modified.paths.includes("packages/base/extra.md"));
    assert.ok(added.paths.includes("scripts/local-only.mjs"));
  });
});

describe("同步幂等性", () => {
  it("对已同步树重复执行受控同步，逐字节无差异", () => {
    const { source, target, repo, policy } = fixture();
    const protectedAssets = loadProtectedAssets(repo);
    const before = new Map();
    const plan = planSync({ sourceRoot: source, targetRoot: target, policy, protectedAssets });
    applyPlan(plan, { sourceRoot: source, targetRoot: target, write: true });
    const snapshot = (path) => sha256(readFileSync(path));
    for (const rel of plan.entries.map((item) => item.targetPath)) {
      const abs = join(target, rel);
      before.set(rel, snapshot(abs));
    }
    const second = planSync({ sourceRoot: source, targetRoot: target, policy, protectedAssets });
    applyPlan(second, { sourceRoot: source, targetRoot: target, write: true });
    for (const [rel, digest] of before.entries()) {
      assert.equal(snapshot(join(target, rel)), digest, `重复同步后 ${rel} 内容发生变化`);
    }
  });
});

describe("CLI 输入保护", () => {
  it("缺少上游工作树时退出码 2 且给出提示", () => {
    const { repo } = fixture();
    try {
      execFileSync(process.execPath, [SCRIPT, "plan", "--repo", repo, "--source", join(repo, "nope"), "--target", repo], {
        encoding: "utf-8",
        stdio: "pipe",
      });
      assert.fail("应当以非零退出");
    } catch (error) {
      assert.equal(error.status, 2);
      assert.match(String(error.stderr), /上游工作树不存在/);
    }
  });

  it("未提供 --source 时提示需要上游工作树", () => {
    const { repo } = fixture();
    try {
      execFileSync(process.execPath, [SCRIPT, "plan", "--repo", repo, "--target", repo], { encoding: "utf-8", stdio: "pipe" });
      assert.fail("应当以非零退出");
    } catch (error) {
      assert.equal(error.status, 2);
      assert.match(String(error.stderr), /需要 --source/);
    }
  });

  it("仓库根与策略路径解析：默认读取仓库根下的策略文件", () => {
    const { repo } = fixture();
    const out = execFileSync(process.execPath, [SCRIPT, "describe", "--repo", repo, "--json"], { encoding: "utf-8" });
    const parsed = JSON.parse(out);
    assert.equal(parsed.schema, "workloom.rename-policy/v1");
    assert.equal(parsed.errors.length, 0);
    assert.ok(parsed.protectedAssets.includes("docs/CONTROLLED.md"));
    assert.equal(resolve(repo).startsWith(resolve(tmpdir())) || existsSync(join(repo, ".workloom-rename-policy.json")), true);
  });
});
