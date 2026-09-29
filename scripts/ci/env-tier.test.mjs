/**
 * env-tier.test.mjs · 环境档位门禁回归（MC-010）
 *
 * 断言的重点不是「能跑」，而是「不许把低档位说成高档位」：
 *   · local-preview 允许 mock / dry-run，但结论不得升级；
 *   · client-runtime 缺任一真实前置（模型凭据 / 出图密钥 / 桌面驱动 / 登录声明 / harness）即失败；
 *   · deployed 追加 NODE_ENV=production 与非本机数据库；
 *   · 平台账号声明过期（>30 天）不得支撑「可真实发布」。
 *
 * 用法：node --test scripts/ci/env-tier.test.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { ACCOUNT_DECLARATION_TTL_DAYS, TIERS, detectTier, evaluateTier } from "./env-tier.mjs";

const SCRIPT = fileURLToPath(new URL("./env-tier.mjs", import.meta.url));

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function repoWithHarness({ harness = true, accounts = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "env-tier-"));
  if (harness) write(join(root, "packages/runtime/dsh-gate/node_modules/.bin/dsh"), "#!/bin/sh\n");
  if (accounts) write(join(root, "ops/publish-accounts.json"), `${JSON.stringify(accounts, null, 2)}\n`);
  return root;
}

const READY_ENV = {
  LLM_PROVIDER: "deepseek",
  DEEPSEEK_API_KEY: "sk-live",
  VOLCENGINE_ARK_API_KEY: "ark-live",
  PUBLISH_DRIVER: "desktop",
  DATABASE_URL: "postgres://user:pass@db.example.com:5432/workloom",
};

const FRESH_ACCOUNTS = {
  schema: "workloom.publish-accounts/v1",
  accounts: [
    { platform: "douyin", accountId: "acc-douyin-1", state: "logged-in", verifiedAt: new Date().toISOString() },
  ],
};

describe("档位解析", () => {
  it("显式声明优先，未声明回落到 local-preview", () => {
    assert.equal(detectTier({ WORKLOOM_ENV_TIER: "deployed" }), "deployed");
    assert.equal(detectTier({ WORKLOOM_ENV: "client-runtime" }), "client-runtime");
    assert.equal(detectTier({}), "local-preview");
    assert.equal(detectTier({ WORKLOOM_ENV_TIER: "  " }), "local-preview");
  });

  it("三档枚举与 RDAS v3.1 §19 对齐", () => {
    assert.deepEqual(TIERS, ["local-preview", "client-runtime", "deployed"]);
  });
});

describe("local-preview 档位", () => {
  it("允许 mock 与 dry-run：仅有告警，不阻断", () => {
    const repo = repoWithHarness({ harness: false });
    const report = evaluateTier({
      tier: "local-preview",
      repoRoot: repo,
      env: { LLM_PROVIDER: "mock", IM_DRIVER: "mock", PUBLISH_TEST_FENCE_OVERRIDE: "1" },
    });
    assert.equal(report.ok, true);
    assert.equal(report.failures.length, 0);
    assert.equal(report.tier, "local-preview");
  });

  it("本机无 DATABASE_URL 时只告警（CI 静态阶段无库）", () => {
    const repo = repoWithHarness({ harness: false });
    const report = evaluateTier({ tier: "local-preview", repoRoot: repo, env: {} });
    const database = report.checks.find((check) => check.id === "local.database");
    assert.equal(database.status, "warn");
    assert.equal(report.ok, true);
  });
});

describe("client-runtime 档位（真实客户端）", () => {
  it("条件齐备时通过", () => {
    const repo = repoWithHarness({ accounts: FRESH_ACCOUNTS });
    const report = evaluateTier({ tier: "client-runtime", repoRoot: repo, env: { ...READY_ENV } });
    assert.equal(report.ok, true, JSON.stringify(report.failures, null, 2));
  });

  it("mock 模型不得冒充真实客户端", () => {
    const repo = repoWithHarness({ accounts: FRESH_ACCOUNTS });
    const report = evaluateTier({
      tier: "client-runtime",
      repoRoot: repo,
      env: { ...READY_ENV, LLM_PROVIDER: "mock" },
    });
    assert.equal(report.ok, false);
    assert.ok(report.failures.some((check) => check.id === "llm.provider"));
  });

  it("缺出图/出视频密钥时判失败（图文与视频产能都依赖 Ark）", () => {
    const repo = repoWithHarness({ accounts: FRESH_ACCOUNTS });
    const env = { ...READY_ENV };
    delete env.VOLCENGINE_ARK_API_KEY;
    const report = evaluateTier({ tier: "client-runtime", repoRoot: repo, env });
    assert.equal(report.ok, false);
    assert.ok(report.failures.some((check) => check.id === "capacity.image"));
    assert.ok(report.failures.some((check) => check.id === "capacity.video"));
  });

  it("发布驱动必须为 desktop，dry-run 不足以宣称真实发布", () => {
    const repo = repoWithHarness({ accounts: FRESH_ACCOUNTS });
    const report = evaluateTier({ tier: "client-runtime", repoRoot: repo, env: { ...READY_ENV, PUBLISH_DRIVER: "dry-run" } });
    assert.equal(report.ok, false);
    assert.ok(report.failures.some((check) => check.id === "publish.driver"));
  });

  it("测试围栏放行开关在真实档位下判失败", () => {
    const repo = repoWithHarness({ accounts: FRESH_ACCOUNTS });
    const report = evaluateTier({
      tier: "client-runtime",
      repoRoot: repo,
      env: { ...READY_ENV, PUBLISH_TEST_FENCE_OVERRIDE: "1" },
    });
    assert.equal(report.ok, false);
    assert.ok(report.failures.some((check) => check.id === "publish.fence-override"));
  });

  it("缺少 ops/publish-accounts.json 时判失败（无登录态声明不得宣称可发布）", () => {
    const repo = repoWithHarness({ harness: true });
    const report = evaluateTier({ tier: "client-runtime", repoRoot: repo, env: { ...READY_ENV } });
    assert.equal(report.ok, false);
    const check = report.failures.find((item) => item.id === "publish.accounts");
    assert.ok(check);
    assert.match(check.detail, /ops\/publish-accounts\.json/);
  });

  it("账号声明过期（超过 TTL）时判失败", () => {
    const staleAt = new Date(Date.now() - (ACCOUNT_DECLARATION_TTL_DAYS + 5) * 24 * 60 * 60 * 1000).toISOString();
    const repo = repoWithHarness({
      accounts: { schema: "workloom.publish-accounts/v1", accounts: [{ platform: "xiaohongshu", accountId: "acc-1", state: "logged-in", verifiedAt: staleAt }] },
    });
    const report = evaluateTier({ tier: "client-runtime", repoRoot: repo, env: { ...READY_ENV } });
    assert.equal(report.ok, false);
    const check = report.failures.find((item) => item.id === "publish.accounts");
    assert.ok(check);
    assert.match(check.detail, /超过 30 天/);
  });

  it("账号声明中全是 logged-out 时判失败", () => {
    const repo = repoWithHarness({
      accounts: {
        schema: "workloom.publish-accounts/v1",
        accounts: [{ platform: "bilibili", accountId: "acc-2", state: "logged-out", verifiedAt: new Date().toISOString() }],
      },
    });
    const report = evaluateTier({ tier: "client-runtime", repoRoot: repo, env: { ...READY_ENV } });
    assert.equal(report.ok, false);
    assert.ok(report.failures.some((item) => item.id === "publish.accounts" && /logged-in/.test(item.detail)));
  });

  it("缺 dsh harness 时判失败（内置模型任务无法执行）", () => {
    const repo = repoWithHarness({ harness: false, accounts: FRESH_ACCOUNTS });
    const report = evaluateTier({ tier: "client-runtime", repoRoot: repo, env: { ...READY_ENV } });
    assert.equal(report.ok, false);
    assert.ok(report.failures.some((item) => item.id === "runtime.dsh-harness"));
  });

  it("账号声明 JSON 损坏时给出可读失败原因", () => {
    const repo = repoWithHarness();
    write(join(repo, "ops/publish-accounts.json"), "{ not-json");
    const report = evaluateTier({ tier: "client-runtime", repoRoot: repo, env: { ...READY_ENV } });
    assert.equal(report.ok, false);
    const check = report.failures.find((item) => item.id === "publish.accounts");
    assert.match(check.detail, /无法解析/);
  });
});

describe("deployed 档位（生产部署）", () => {
  it("含 client-runtime 全部条件 + NODE_ENV=production + 非本机库", () => {
    const repo = repoWithHarness({ accounts: FRESH_ACCOUNTS });
    const report = evaluateTier({
      tier: "deployed",
      repoRoot: repo,
      env: { ...READY_ENV, NODE_ENV: "production" },
    });
    assert.equal(report.ok, true, JSON.stringify(report.failures, null, 2));
  });

  it("NODE_ENV 非 production 判失败", () => {
    const repo = repoWithHarness({ accounts: FRESH_ACCOUNTS });
    const report = evaluateTier({ tier: "deployed", repoRoot: repo, env: { ...READY_ENV, NODE_ENV: "staging" } });
    assert.equal(report.ok, false);
    assert.ok(report.failures.some((item) => item.id === "env.node"));
  });

  it("数据库指向本机时判失败", () => {
    const repo = repoWithHarness({ accounts: FRESH_ACCOUNTS });
    const report = evaluateTier({
      tier: "deployed",
      repoRoot: repo,
      env: { ...READY_ENV, NODE_ENV: "production", DATABASE_URL: "postgres://postgres:workloom@localhost:5432/workloom" },
    });
    assert.equal(report.ok, false);
    assert.ok(report.failures.some((item) => item.id === "env.database-remote"));
  });
});

describe("CLI", () => {
  it("未知档位退出码 2", () => {
    try {
      execFileSync(process.execPath, [SCRIPT, "--tier", "production"], { encoding: "utf-8", stdio: "pipe" });
      assert.fail("应当非零退出");
    } catch (error) {
      assert.equal(error.status, 2);
      assert.match(String(error.stderr), /未知档位/);
    }
  });

  it("--describe 打印条件矩阵，--json 输出结构化报告", () => {
    const matrix = execFileSync(process.execPath, [SCRIPT, "--describe", "--json"], { encoding: "utf-8" });
    const parsedMatrix = JSON.parse(matrix);
    assert.ok(parsedMatrix.some((row) => row.id === "publish.driver" && row.appliesTo.includes("client-runtime")));
    const repo = repoWithHarness({ harness: false });
    const report = execFileSync(process.execPath, [SCRIPT, "--tier", "local-preview", "--repo", repo, "--json"], {
      encoding: "utf-8",
    });
    const parsed = JSON.parse(report);
    assert.equal(parsed.schema, "workloom.env-tier-report/v1");
    assert.equal(parsed.tier, "local-preview");
    assert.equal(parsed.ok, true);
  });

  it("client-runtime 条件不满足时退出码 1", () => {
    const repo = repoWithHarness({ harness: false });
    try {
      execFileSync(process.execPath, [SCRIPT, "--tier", "client-runtime", "--repo", repo], { encoding: "utf-8", stdio: "pipe" });
      assert.fail("应当非零退出");
    } catch (error) {
      assert.equal(error.status, 1);
      assert.match(String(error.stdout), /不得对外宣称该档位能力/);
    }
  });
});
