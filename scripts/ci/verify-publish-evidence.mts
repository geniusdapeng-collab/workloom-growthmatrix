#!/usr/bin/env node
/**
 * verify-publish-evidence.mts · 发布回执可核验门禁（MC-010 fail-closed）
 *
 * 为什么需要它：
 *   `publish_tasks` 里的 `status='succeeded'` 是系统对外的「已发布」事实源。历史上存在三种可被误读的形态：
 *     ① dry-run 驱动跑通机制 → 回执里是演练语义，不能算真实发布；
 *     ② 回执只有 `synced:true` 但没有平台帖 ID / URL —— 无证据；
 *     ③ 手工改库或旧版本写入的 succeeded 行没有任何回执行。
 *   本脚本按「无证据 = 未核实」纪律把它们全部揪出来；退出码非零即阻断，不允许带病宣称发布能力。
 *
 * 判定（逐行）：
 *   status='succeeded' 的行必须同时满足：
 *     · receipt 是对象且 receipt.synced === true；
 *     · receipt.platformPostId 或 receipt.url 至少一个非空；
 *     · receipt.mode / receipt.driver 不得为 "dry-run"（dry-run 演练不得记为成功）；
 *     · 最近版本要求的 verifiedAt 若存在必须可解析为时间。
 *
 * 用法：
 *   pnpm publish:evidence                     # 读 .env 的 DATABASE_URL
 *   pnpm publish:evidence -- --json
 *   pnpm publish:evidence -- --workspace ws-geo --limit 200
 *   pnpm publish:evidence -- --allow-missing-db   # 仅本机预览档位可用：无库时降级为告警
 *
 * 退出码：0 = 全部 succeeded 行有可核验证据；1 = 存在无证据的「已发布」；2 = 无法连接/无表（未被 --allow-missing-db 放行）。
 */
import pg from "pg";

interface Flags {
  json: boolean;
  allowMissingDb: boolean;
  workspace: string | null;
  limit: number;
  tier: string;
}

interface PublishRow {
  id: string;
  workspace_id: string;
  platform: string;
  status: string;
  executed_at: string | null;
  receipt: unknown;
}

interface Violation {
  taskId: string;
  workspaceId: string;
  platform: string;
  executedAt: string | null;
  reason: string;
}

function parseFlags(argv: string[]): Flags {
  const arg = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const limitRaw = Number(arg("--limit") ?? "500");
  return {
    json: argv.includes("--json"),
    allowMissingDb: argv.includes("--allow-missing-db"),
    workspace: arg("--workspace") ?? null,
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 500,
    tier: arg("--tier") ?? process.env.WORKLOOM_ENV_TIER ?? "local-preview",
  };
}

export function evaluateReceipt(row: Pick<PublishRow, "id" | "platform" | "receipt">): string[] {
  const problems: string[] = [];
  const receipt = row.receipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    problems.push("回执缺失或不是对象（无回执 = 未核实）");
    return problems;
  }
  const value = receipt as Record<string, unknown>;
  if (value.synced !== true) problems.push("receipt.synced 不是 true");
  const postId = typeof value.platformPostId === "string" && value.platformPostId.trim() ? value.platformPostId.trim() : "";
  const url = typeof value.url === "string" && value.url.trim() ? value.url.trim() : "";
  if (!postId && !url) problems.push("缺少平台侧证据（platformPostId / url 均为空）");
  const mode = typeof value.mode === "string" ? value.mode : "";
  const driver = typeof value.driver === "string" ? value.driver : "";
  if (mode === "dry-run" || driver === "dry-run") {
    problems.push(`演练回执不得记为已发布（mode=${mode || "-"} driver=${driver || "-"}）`);
  }
  if (value.verifiedAt !== undefined) {
    const parsed = Date.parse(String(value.verifiedAt));
    if (!Number.isFinite(parsed)) problems.push(`verifiedAt 不是合法时间：${String(value.verifiedAt)}`);
  }
  return problems;
}

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL ?? "postgres://postgres:workloom@localhost:5432/workloom";
  const pool = new pg.Pool({ connectionString, max: 2 });
  try {
    const params: unknown[] = [];
    const conditions = ["status = 'succeeded'"];
    if (flags.workspace) {
      params.push(flags.workspace);
      conditions.push(`workspace_id = $${params.length}`);
    }
    params.push(flags.limit);
    const sql = `SELECT id, workspace_id, platform, status, executed_at, receipt
                   FROM publish_tasks
                  WHERE ${conditions.join(" AND ")}
                  ORDER BY executed_at DESC NULLS LAST
                  LIMIT $${params.length}`;
    const result = await pool.query<PublishRow>(sql, params);
    const violations: Violation[] = [];
    for (const row of result.rows) {
      const problems = evaluateReceipt(row);
      if (problems.length) {
        violations.push({
          taskId: row.id,
          workspaceId: row.workspace_id,
          platform: row.platform,
          executedAt: row.executed_at,
          reason: problems.join("；"),
        });
      }
    }
    const report = {
      schema: "workloom.publish-evidence-report/v1",
      generatedAt: new Date().toISOString(),
      tier: flags.tier,
      workspace: flags.workspace,
      scanned: result.rows.length,
      violations,
    };
    if (flags.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`[publish-evidence] 档位 ${flags.tier} · 扫描 succeeded 任务 ${result.rows.length} 条`);
      for (const violation of violations) {
        console.log(`  ✗ ${violation.taskId}（${violation.platform}）：${violation.reason}`);
      }
      console.log(
        violations.length
          ? `[publish-evidence] 失败：${violations.length} 条「已发布」缺少可核验证据（不得对外宣称真实发布）`
          : "[publish-evidence] 通过：所有 succeeded 任务都有可核验的平台证据",
      );
    }
    return violations.length ? 1 : 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (flags.allowMissingDb) {
      console.log(`[publish-evidence] ⚠ 无法核验（${message}）；已按 --allow-missing-db 放行——该档位不得宣称真实发布`);
      return 0;
    }
    console.error(`[publish-evidence] 无法核验：${message}`);
    console.error("  提示：本机预览无库时用 --allow-missing-db；真实档位必须能连库核验。");
    return 2;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

const invokedDirectly = process.argv[1]?.endsWith("verify-publish-evidence.mts") ?? false;
if (invokedDirectly) {
  main().then((code) => {
    process.exitCode = code;
  });
}

export { main as runPublishEvidenceCheck };
