#!/usr/bin/env node
/**
 * env-tier.mjs · 环境档位门禁（MC-010 的「诚实档位」闸门）
 *
 * 为什么需要它：
 *   2026-09-29 的交付里，「真实发布 / 图文产能」长期只能到 local-preview（`LLM_PROVIDER=mock`、
 *   无平台登录态、无云渲染密钥），但系统与报告都可能被读成「已经能真实发布」。档位必须机器可判，
 *   不靠口头声明。本脚本把 RDAS v3.1 §19 的三档（local-preview / client-runtime / deployed）
 *   落成一组**可执行断言**：声明哪一档，就必须满足哪一档的前置条件；缺一项即 fail-closed。
 *
 * 三档与必需条件（完整矩阵见 `--describe`）：
 *   · local-preview：本机预览，允许 mock 模型与 dry-run 发布；DATABASE_URL 缺失仅告警。
 *   · client-runtime：真实桌面客户端运行时——必须真实模型凭据（非 mock）、必须有出图/出视频密钥、
 *     必须 `PUBLISH_DRIVER=desktop`、必须未开测试围栏放行、必须有已登录平台账号声明（30 天内核验）。
 *   · deployed：生产部署——在 client-runtime 之上再加 `NODE_ENV=production` 与非本机数据库。
 *
 * 用法：
 *   node scripts/ci/env-tier.mjs                                  # 按 WORKLOOM_ENV_TIER 或默认 local-preview 自检
 *   node scripts/ci/env-tier.mjs --tier client-runtime            # 声明档位并校验
 *   node scripts/ci/env-tier.mjs --describe                       # 打印完整条件矩阵
 *   node scripts/ci/env-tier.mjs --json --report outputs/env-tier.json
 *
 * 退出码：0 = 档位条件满足（可有告警）；1 = 阻断项未满足；2 = 用法错误。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TIERS = ["local-preview", "client-runtime", "deployed"];
export const DEFAULT_TIER = "local-preview";
/** 平台账号登录声明的有效期（天）：超过即视为过期，不能再支撑「可真实发布」结论 */
export const ACCOUNT_DECLARATION_TTL_DAYS = 30;

export function detectTier(env = process.env) {
  const declared = env.WORKLOOM_ENV_TIER ?? env.WORKLOOM_ENV ?? DEFAULT_TIER;
  return String(declared).trim() || DEFAULT_TIER;
}

function present(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isLocalHost(url) {
  if (!present(url)) return false;
  try {
    const host = new URL(String(url)).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local");
  } catch {
    return /(^|\/\/)(localhost|127\.0\.0\.1)/.test(String(url));
  }
}

function readJsonSafe(path) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf-8")) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 条件矩阵：新增条件时只改这里，CLI/文档/测试都读同一份 */
export const TIER_MATRIX = [
  {
    id: "tier.declared",
    label: "档位取值合法（local-preview | client-runtime | deployed）",
    appliesTo: TIERS,
    severity: "blocking",
    kind: "meta",
  },
  {
    id: "llm.provider",
    label: "模型提供方非 mock（真实模型链路）",
    appliesTo: ["client-runtime", "deployed"],
    severity: "blocking",
    kind: "envForbidden",
    keys: ["LLM_PROVIDER"],
    forbidden: ["mock", "stub", "fake"],
  },
  {
    id: "llm.credential",
    label: "内置模型凭据在位（DEEPSEEK_API_KEY / LLM_API_KEY）",
    appliesTo: ["client-runtime", "deployed"],
    severity: "blocking",
    kind: "anyEnv",
    keys: ["DEEPSEEK_API_KEY", "LLM_API_KEY"],
  },
  {
    id: "capacity.image",
    label: "图文产能密钥在位（Seedream / VOLCENGINE_ARK_API_KEY）",
    appliesTo: ["client-runtime", "deployed"],
    severity: "blocking",
    kind: "env",
    keys: ["VOLCENGINE_ARK_API_KEY"],
  },
  {
    id: "capacity.video",
    label: "视频产能密钥在位（Seedance / VOLCENGINE_ARK_API_KEY）",
    appliesTo: ["client-runtime", "deployed"],
    severity: "blocking",
    kind: "env",
    keys: ["VOLCENGINE_ARK_API_KEY"],
  },
  {
    id: "publish.driver",
    label: "发布驱动为桌面真实驱动（PUBLISH_DRIVER=desktop）",
    appliesTo: ["client-runtime", "deployed"],
    severity: "blocking",
    kind: "envEquals",
    keys: ["PUBLISH_DRIVER"],
    expected: "desktop",
  },
  {
    id: "publish.fence-override",
    label: "测试围栏放行开关未开启（PUBLISH_TEST_FENCE_OVERRIDE≠1）",
    appliesTo: ["client-runtime", "deployed"],
    severity: "blocking",
    kind: "envNotEquals",
    keys: ["PUBLISH_TEST_FENCE_OVERRIDE"],
    unexpected: "1",
  },
  {
    id: "publish.accounts",
    label: "存在 30 天内核验的已登录平台账号声明（ops/publish-accounts.json）",
    appliesTo: ["client-runtime", "deployed"],
    severity: "blocking",
    kind: "accountDeclaration",
  },
  {
    id: "runtime.dsh-harness",
    label: "客户端内置模型 harness 已安装（packages/runtime/dsh-gate/node_modules/.bin/dsh）",
    appliesTo: ["client-runtime", "deployed"],
    severity: "blocking",
    kind: "file",
  },
  {
    id: "env.database",
    label: "数据库连接串在位（DATABASE_URL）",
    appliesTo: ["client-runtime", "deployed"],
    severity: "blocking",
    kind: "env",
    keys: ["DATABASE_URL"],
  },
  {
    id: "env.node",
    label: "生产部署档位要求 NODE_ENV=production",
    appliesTo: ["deployed"],
    severity: "blocking",
    kind: "envEquals",
    keys: ["NODE_ENV"],
    expected: "production",
  },
  {
    id: "env.database-remote",
    label: "生产部署不得指向本机数据库",
    appliesTo: ["deployed"],
    severity: "blocking",
    kind: "remoteDatabase",
  },
  {
    id: "local.mock-allowed",
    label: "local-preview 允许 mock 模型与 dry-run 发布（仅告警）",
    appliesTo: ["local-preview"],
    severity: "advisory",
    kind: "meta",
  },
  {
    id: "local.database",
    label: "本机预览库连接串（缺失仅告警，CI 静态阶段无库）",
    appliesTo: ["local-preview"],
    severity: "advisory",
    kind: "env",
    keys: ["DATABASE_URL"],
  },
];

function evaluateCheck(check, ctx) {
  const { tier, env, repoRoot, home } = ctx;
  const required = check.appliesTo.includes(tier);
  if (!required) {
    return { ...check, required: false, status: "skip", detail: `不适用于 ${tier}` };
  }
  const severity = check.severity;
  const fail = (detail) => ({ ...check, required: true, status: severity === "blocking" ? "fail" : "warn", detail });
  const pass = (detail) => ({ ...check, required: true, status: "pass", detail });

  switch (check.kind) {
    case "meta":
      if (check.id === "tier.declared") {
        return TIERS.includes(tier)
          ? pass(`档位 ${tier}`)
          : fail(`未知档位 ${tier}（可选 ${TIERS.join(" | ")}）`);
      }
      return pass("允许 mock / dry-run（本档位结论不得用于生产声明）");
    case "env": {
      const key = check.keys[0];
      const value = env[key];
      if (!present(value)) return fail(`缺少环境变量 ${key}`);
      return pass(`${key} 已配置`);
    }
    case "anyEnv": {
      const hit = check.keys.filter((key) => present(env[key]));
      if (!hit.length) return fail(`以下环境变量至少需要一个：${check.keys.join(" / ")}`);
      return pass(`命中 ${hit.join(" / ")}`);
    }
    case "envEquals": {
      const key = check.keys[0];
      const value = String(env[key] ?? "");
      if (value !== check.expected) return fail(`${key}=${value || "(空)"}，要求 ${check.expected}`);
      return pass(`${key}=${value}`);
    }
    case "envForbidden": {
      const key = check.keys[0];
      const value = String(env[key] ?? "").trim().toLowerCase();
      if (!value) return fail(`缺少环境变量 ${key}（真实档位不得缺省为 mock）`);
      if (check.forbidden.includes(value)) {
        return fail(`${key}=${value}（mock/stub 链路不得用于真实档位：结论只能记为 local-preview）`);
      }
      return pass(`${key}=${value}`);
    }
    case "envNotEquals": {
      const key = check.keys[0];
      const value = String(env[key] ?? "");
      if (value === check.unexpected) {
        return fail(
          severity === "blocking"
            ? `${key}=${value}（测试专用开关，禁止在真实档位开启）`
            : `${key}=${value}（本机演练可接受，但结论不得升级为真实档位）`,
        );
      }
      return pass(`${key}=${value || "(未设置)"}`);
    }
    case "file": {
      const rel = "packages/runtime/dsh-gate/node_modules/.bin/dsh";
      return existsSync(join(repoRoot, rel)) ? pass(`${rel} 在位`) : fail(`缺少 ${rel}（在 packages/runtime/dsh-gate 内执行 pnpm install --ignore-workspace）`);
    }
    case "remoteDatabase": {
      const url = String(env.DATABASE_URL ?? "");
      if (!present(url)) return fail("缺少 DATABASE_URL（先修 env.database）");
      return isLocalHost(url) ? fail("DATABASE_URL 指向本机，生产档位必须是非本机数据库") : pass("DATABASE_URL 非本机");
    }
    case "accountDeclaration": {
      const path = join(repoRoot, "ops/publish-accounts.json");
      if (!existsSync(path)) {
        return fail("缺少 ops/publish-accounts.json（模板见 ops/publish-accounts.example.json；登录态为机器本地状态，不入库）");
      }
      const parsed = readJsonSafe(path);
      if (!parsed.ok) return fail(`ops/publish-accounts.json 无法解析：${parsed.error}`);
      const accounts = Array.isArray(parsed.value?.accounts) ? parsed.value.accounts : [];
      const loggedIn = accounts.filter((account) => account?.state === "logged-in");
      if (!loggedIn.length) return fail("声明文件中没有 state=logged-in 的平台账号");
      const now = Date.now();
      const ttlMs = ACCOUNT_DECLARATION_TTL_DAYS * 24 * 60 * 60 * 1000;
      const fresh = loggedIn.filter((account) => {
        const verifiedAt = Date.parse(String(account?.verifiedAt ?? ""));
        return Number.isFinite(verifiedAt) && now - verifiedAt <= ttlMs;
      });
      if (!fresh.length) {
        return fail(`已登录账号的 verifiedAt 全部超过 ${ACCOUNT_DECLARATION_TTL_DAYS} 天（需重新核验并更新）`);
      }
      return pass(`${fresh.length} 个平台账号在 ${ACCOUNT_DECLARATION_TTL_DAYS} 天内核验（${fresh.map((a) => a.platform).join(" / ")}）`);
    }
    default:
      return fail(`未知检查类型 ${check.kind}（脚本缺陷）`);
  }
}

export function evaluateTier({ tier, env = process.env, repoRoot = process.cwd(), home = homedir() } = {}) {
  const resolvedTier = tier ?? detectTier(env);
  const ctx = { tier: resolvedTier, env, repoRoot: resolve(repoRoot), home };
  const checks = TIER_MATRIX.map((check) => evaluateCheck(check, ctx));
  const failures = checks.filter((check) => check.status === "fail");
  const warnings = checks.filter((check) => check.status === "warn");
  return {
    schema: "workloom.env-tier-report/v1",
    generatedAt: new Date().toISOString(),
    tier: resolvedTier,
    ok: failures.length === 0,
    checks,
    failures,
    warnings,
    summary: {
      total: checks.length,
      pass: checks.filter((check) => check.status === "pass").length,
      fail: failures.length,
      warn: warnings.length,
      skip: checks.filter((check) => check.status === "skip").length,
    },
  };
}

export function describeMatrix() {
  return TIER_MATRIX.map((check) => ({
    id: check.id,
    label: check.label,
    appliesTo: check.appliesTo,
    severity: check.severity,
    kind: check.kind,
  }));
}

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

function printReport(report) {
  console.log(`[env-tier] 环境档位：${report.tier}`);
  for (const check of report.checks) {
    const mark = check.status === "pass" ? "✓" : check.status === "fail" ? "✗" : check.status === "warn" ? "⚠" : "–";
    console.log(`  ${mark} ${check.id.padEnd(24)} ${check.label}`);
    if (check.status !== "skip" || check.required) console.log(`      ${check.detail}`);
  }
  console.log(
    `  汇总：pass ${report.summary.pass} · fail ${report.summary.fail} · warn ${report.summary.warn} · skip ${report.summary.skip}`,
  );
  console.log(
    report.ok
      ? `[env-tier] ${report.tier} 档位前置条件满足${report.summary.warn ? "（含告警）" : ""}`
      : `[env-tier] ${report.tier} 档位前置条件不满足：不得对外宣称该档位能力`,
  );
}

export function main(argv = process.argv) {
  const flags = parseArgs(argv);
  if (flags.describe) {
    const matrix = describeMatrix();
    if (flags.json) console.log(JSON.stringify(matrix, null, 2));
    else {
      console.log("[env-tier] 条件矩阵（severity=blocking 的条件必须满足）");
      for (const row of matrix) {
        console.log(`  · ${row.id.padEnd(24)} [${row.severity}] ${row.label}`);
        console.log(`      适用档位：${row.appliesTo.join(" / ")}`);
      }
    }
    return 0;
  }
  const tier = flags.tier ? String(flags.tier) : undefined;
  if (tier && !TIERS.includes(tier)) {
    console.error(`[env-tier] 未知档位：${tier}（可选 ${TIERS.join(" | ")}）`);
    return 2;
  }
  const report = evaluateTier({
    tier,
    repoRoot: String(flags.repo ?? process.cwd()),
    home: String(flags.home ?? homedir()),
  });
  if (flags.report) {
    const path = resolve(String(flags.report));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (flags.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
  return report.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exitCode = main();
}
