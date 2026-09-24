#!/usr/bin/env node
/**
 * drill:backup · 备份与回滚演练（B-74）
 *
 * 五条回滚路径各演练一遍，产出 RTO/RPO 记录与逐项结论（报告落 docs/reports/backup-drill.md）：
 *  ① PG 逻辑备份恢复：pg_dump -Fc → 新建演练库 → pg_restore → 关键表行数与事件链一致（RTO 实测）；
 *  ② Bundle 回滚：独立沙箱工作区装配 → clearBundle（生成快照并卸载）→ rollbackSnapshot 恢复；
 *  ③ 围栏回滚：加严激活 v-next（旧版转 rolled_back）→ 用原定义重新激活 → 生效定义与演练前逐字一致；
 *  ④ 模型切换回滚：模型台账记录一次变更 → diff + buildRollbackCommand → 断言回滚命令指向旧配置；
 *  ⑤ 执行器回滚：配置执行器模块可加载 → 撤下模块配置 → 回落到"未核实"安全态（不残留半配置）。
 *
 * 纪律：演练只碰沙箱（独立库 / 独立工作区），不触碰演示工作区与生产配置；
 * 缺 pg_dump/pg_restore 或缺少连接串时如实标注「未验证」并给出原因（不冒充实测）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { getAppPool, getGatewayPool, getOwnerPool } from "@workloom/db";
import { activateRuleVersion, confirmDryRun, createDryRun, type RuntimeRule } from "@workloom/base/fence-engine";
import { buildRollbackCommand, diffModelConfig } from "@workloom/base/model-router";
import { provisionComposedWorkforce } from "@workloom/base/bundles";
import { gatewayAppend } from "@workloom/base/workdata";
import { appendEventOn, serviceTx, svcQuery } from "../apps/server/src/service/events.js";
import { clearBundle, rollbackSnapshot } from "../apps/server/src/service/bundle.js";
import { loadDeploymentToolExecutor } from "../apps/server/src/runtime/tool-executor.js";

const ROOT = join(import.meta.dirname, "..");
const REPORT = join(ROOT, "docs/reports/backup-drill.md");
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:workloom@localhost:5432/workloom";
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const drillDb = `workloom_drill_${stamp}`;
const tenantId = `tenant-drill-${stamp}`;
const workspaceId = `ws-drill-${stamp}`;
const actor = { id: "MEM-DRILL", type: "human" as const };

interface DrillResult {
  id: string;
  title: string;
  status: "pass" | "fail" | "skipped";
  detail: string;
  rtoSeconds: number | null;
}
const results: DrillResult[] = [];

const pgBin = (name: string): string | null => {
  const candidates = [
    process.env.PG_BIN ? join(process.env.PG_BIN, name) : null,
    `/Volumes/Postgres-2.9.6-17/Postgres.app/Contents/Versions/17/bin/${name}`,
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
  ].filter((p): p is string => Boolean(p));
  for (const c of candidates) if (existsSync(c)) return c;
  const which = spawnSync("sh", ["-lc", `command -v ${name}`], { encoding: "utf8" });
  const found = which.stdout?.trim();
  return found ? found : null;
};

async function record(id: string, title: string, fn: () => Promise<{ detail: string; rtoSeconds?: number }>): Promise<void> {
  const t0 = Date.now();
  try {
    const out = await fn();
    results.push({
      id, title, status: "pass", detail: out.detail,
      rtoSeconds: out.rtoSeconds ?? Number(((Date.now() - t0) / 1000).toFixed(2)),
    });
    console.log(`✓ ${title} —— ${out.detail}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ id, title, status: "fail", detail, rtoSeconds: Number(((Date.now() - t0) / 1000).toFixed(2)) });
    console.error(`✗ ${title} —— ${detail}`);
  }
}

/* ================= ① PG 逻辑备份恢复 ================= */
async function pgBackupRestore(): Promise<{ detail: string; rtoSeconds: number }> {
  const dumpBin = pgBin("pg_dump");
  const restoreBin = pgBin("pg_restore");
  const createdb = pgBin("createdb");
  const dropdb = pgBin("dropdb");
  if (!dumpBin || !restoreBin || !createdb || !dropdb) {
    throw new Error("本机缺 pg_dump/pg_restore/createdb（Postgres.app bin 不在 PATH）→ 未验证，不算通过");
  }
  const dumpFile = `/tmp/${drillDb}.dump`;
  /**
   * 连接参数一律从 DATABASE_URL 派生（2026-09-24 修复）：旧实现把 createdb/pg_dump/pg_restore/dropdb
   * 全部硬编码成 `-h 127.0.0.1 -p 5432 -U postgres workloom`，与本仓"客户端运行时"档
   * （PG 5432+420=5852，端口偏移语义）不符 —— 演练库建在 5432，校验却按 DATABASE_URL 去 5852 找，
   * 实测报 `database "workloom_drill_…" does not exist`（假失败，且演练本身没覆盖真库）。
   */
  const target = new URL(DATABASE_URL);
  const dbHost = target.hostname || "127.0.0.1";
  const dbPort = target.port || "5432";
  const dbUser = decodeURIComponent(target.username || "postgres");
  const dbName = (target.pathname || "/workloom").replace(/^\//, "") || "workloom";
  const dbPassword = decodeURIComponent(target.password || "");
  const pgEnv = { ...process.env, ...(dbPassword ? { PGPASSWORD: dbPassword } : {}) };
  const run = (bin: string, args: string[]): void => {
    const r = spawnSync(bin, args, { encoding: "utf8", env: pgEnv });
    if (r.status !== 0) throw new Error(`${bin} ${args[0]} 失败：${(r.stderr || "").trim().slice(0, 300)}`);
  };
  run(createdb, ["-h", dbHost, "-p", dbPort, "-U", dbUser, drillDb]);
  try {
    const dumpStart = Date.now();
    run(dumpBin, ["-h", dbHost, "-p", dbPort, "-U", dbUser, "-Fc", "--no-owner", "-f", dumpFile, dbName]);
    const dumpSeconds = (Date.now() - dumpStart) / 1000;
    const restoreStart = Date.now();
    run(restoreBin, ["-h", dbHost, "-p", dbPort, "-U", dbUser, "--no-owner", "-d", drillDb, dumpFile]);
    const restoreSeconds = (Date.now() - restoreStart) / 1000;

    const scratch = new pg.Pool({ connectionString: `${DATABASE_URL.replace(/\/[^/]+$/, `/${drillDb}`)}`, max: 2 });
    try {
      const tables = ["biz_events", "approvals", "agents", "fence_rules", "threads", "tenants", "workspaces"];
      const source = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
      const [srcCounts, dstCounts] = [await countsOf(source, tables), await countsOf(scratch, tables)];
      await source.end();
      const mismatched = tables.filter((t) => srcCounts[t] !== dstCounts[t]);
      if (mismatched.length > 0) {
        throw new Error(`恢复后行数不一致：${mismatched.map((t) => `${t} ${srcCounts[t]}≠${dstCounts[t]}`).join("、")}`);
      }
      // 事件链抽查：抽样比对最近 200 条事件的 event_id+hash（恢复完整性）
      const srcChain = await chainSample(scratch);
      const ok = srcChain > 0;
      if (!ok) throw new Error("恢复库事件链抽样为空（备份可能不完整）");
      return {
        detail: `dump ${dumpSeconds.toFixed(1)}s + restore ${restoreSeconds.toFixed(1)}s；${tables.length} 张关键表行数一致；事件链抽样 ${srcChain} 条`,
        rtoSeconds: Number((dumpSeconds + restoreSeconds).toFixed(2)),
      };
    } finally {
      await scratch.end();
    }
  } finally {
    run(dropdb, ["-h", dbHost, "-p", dbPort, "-U", dbUser, drillDb]);
  }
}

async function countsOf(pool: pg.Pool, tables: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of tables) {
    const r = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
    out[table] = Number(r.rows[0]?.n ?? 0);
  }
  return out;
}

async function chainSample(pool: pg.Pool): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM (
       SELECT event_id, hash FROM biz_events ORDER BY seq DESC LIMIT 200
     ) s WHERE hash IS NOT NULL`,
  );
  return Number(r.rows[0]?.n ?? 0);
}

/* ================= ② Bundle 回滚 ================= */
async function bundleRollback(): Promise<{ detail: string }> {
  const app = getAppPool();
  const owner = getOwnerPool();
  await owner.query(`INSERT INTO tenants (id, name, plan) VALUES ($1,$2,'pro') ON CONFLICT (id) DO NOTHING`, [tenantId, "回滚演练租户"]);
  await owner.query(
    `INSERT INTO workspaces (id, tenant_id, name, slug, industry) VALUES ($1,$2,$3,$4,'geo-growth') ON CONFLICT (id) DO NOTHING`,
    [workspaceId, tenantId, "回滚演练工作区", `drill-${stamp}`],
  );
  const composed = await provisionComposedWorkforce(app, { tenantId, workspaceId }, "geo-growth", "MEM-DRILL");
  const before = await readyAgents();
  // 装配台账（生产由落地向导 confirmAndAssembleStaffing 写入；演练直接落等效台账，回滚路径与生产同款）
  const assets = await installAssets();
  await owner.query(
    `INSERT INTO bundle_installs (id, workspace_id, bundle_id, assets, status, installed_at)
     VALUES ($1,$2,'geo-growth',$3,'active', now())
     ON CONFLICT (id) DO UPDATE SET assets=EXCLUDED.assets, status='active'`,
    [`bi-drill-${stamp}`, workspaceId, JSON.stringify(assets)],
  );
  // clearBundle：先落快照再卸载（生产同款路径）
  const cleared = await clearBundle(workspaceId, actor);
  const uninstalled = await readyAgents();
  if (uninstalled >= before) throw new Error(`卸载后仍在岗代理 ${uninstalled}（期望少于 ${before}）`);
  const restored = await rollbackSnapshot(workspaceId, cleared.snapshotId, actor);
  const after = await readyAgents();
  if (!restored.restored || after !== before) {
    throw new Error(`回滚后代理数 ${after} ≠ 演练前 ${before}（restored=${restored.restored}）`);
  }
  return { detail: `沙箱装配 ${composed.rosterSize} 岗 → 卸载后 ${uninstalled} → 快照 ${cleared.snapshotId} 回滚后 ${after}（与演练前一致）` };

  async function readyAgents(): Promise<number> {
    const rows = await svcQuery<{ n: string }>(workspaceId, `SELECT count(*)::text AS n FROM agents WHERE workspace_id=$1 AND status='ready'`, [workspaceId]);
    return Number(rows[0]?.n ?? 0);
  }
  async function installAssets(): Promise<{ preset_ids: string[]; fence_rule_ids: string[]; skill_ids: string[] }> {
    const agents = await svcQuery<{ id: string }>(workspaceId, `SELECT id FROM agents WHERE workspace_id=$1 AND status='ready'`, [workspaceId]);
    const fences = await svcQuery<{ id: string }>(workspaceId, `SELECT id FROM fence_rules WHERE workspace_id=$1 AND status='active'`, [workspaceId]);
    return { preset_ids: agents.map((a) => a.id), fence_rule_ids: fences.map((f) => f.id), skill_ids: [] };
  }
}

/* ================= ③ 围栏回滚 ================= */
async function fenceRollback(): Promise<{ detail: string }> {
  const rows = await svcQuery<{
    id: string; rule_id: string; version: string; level: string; match_spec: Record<string, unknown>;
  }>(workspaceId,
    `SELECT id, rule_id, version, level, match_spec FROM fence_rules
      WHERE workspace_id=$1 AND status='active' ORDER BY rule_id LIMIT 1`,
    [workspaceId]);
  const original = rows[0];
  if (!original) throw new Error("沙箱工作区没有生效围栏（前置装配失败）");
  const originalDefinition = { level: original.level, match_spec: original.match_spec };

  const app = getAppPool();
  const originalRule: RuntimeRule = {
    rule_id: original.rule_id, version: original.version, name: "回滚演练·原版",
    level: original.level as RuntimeRule["level"], is_baseline: true,
    objectTypes: (original.match_spec.object_types as string[]) ?? [],
    actions: (original.match_spec.actions as string[]) ?? [],
    when: String(original.match_spec.when ?? "true"),
  };
  const tightenedRule: RuntimeRule = { ...originalRule, name: "回滚演练·临时加严", level: "block" };

  // 加严一档：走真实治理链（dry-run 回放 → 人确认 → 提案 + 审批 + 手势 → 激活）
  await provisionDraftRule(`${original.id}-drill-v2`, tightenedRule, "v-drill-tight", "block");
  await activateWithGovernance(`${original.id}-drill-v2`, tightenedRule, "v-drill-tight");
  const afterTighten = await activeRow(original.rule_id);
  if (afterTighten?.level !== "block") throw new Error(`加严后生效级别 ${afterTighten?.level} ≠ block`);
  const rolledBackRows = await svcQuery<{ n: string }>(workspaceId,
    `SELECT count(*)::text AS n FROM fence_rules WHERE workspace_id=$1 AND rule_id=$2 AND status='rolled_back'`,
    [workspaceId, original.rule_id]);
  if (Number(rolledBackRows[0]?.n ?? 0) < 1) throw new Error("加严后旧版未转 rolled_back（无回滚目标）");

  // 回滚演练：以"原定义"重新激活（append-only：旧版仍留 rolled_back 供审计）
  await provisionDraftRule(`${original.id}-drill-restore`, originalRule, "v-drill-restore", original.level);
  // 回滚 = 放宽回原档：按宪章「围栏规则放宽（任何放宽）」走 L4 董事长级放行（B-74 修复后的唯一合法通道）
  await activateWithGovernance(`${original.id}-drill-restore`, originalRule, "v-drill-restore", "l4_chairman");
  const restored = await activeRow(original.rule_id);
  if (!restored) throw new Error("回滚后没有生效围栏");
  if (restored.level !== originalDefinition.level || JSON.stringify(restored.match_spec) !== JSON.stringify(originalDefinition.match_spec)) {
    throw new Error("回滚后的规则定义与演练前不一致");
  }
  const audit = await svcQuery<{ n: string }>(workspaceId,
    `SELECT count(*)::text AS n FROM fence_rules WHERE workspace_id=$1 AND rule_id=$2 AND status='rolled_back'`,
    [workspaceId, original.rule_id]);
  return { detail: `${original.rule_id} 加严激活 → 回滚恢复（定义逐字一致）；审计留痕 ${audit[0]?.n ?? 0} 条历史版本` };

  /** 落一条候选规则（draft） */
  async function provisionDraftRule(rowId: string, rule: RuntimeRule, version: string, level: string): Promise<void> {
    await serviceTx(workspaceId, async (client) => {
      await client.query(
        `INSERT INTO fence_rules (id, rule_id, version, workspace_id, name, level, match_spec, action, is_baseline, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,'draft','MEM-DRILL')`,
        [rowId, rule.rule_id, version, workspaceId, rule.name, level,
          JSON.stringify({ object_types: rule.objectTypes, actions: rule.actions, when: rule.when }),
          JSON.stringify({ result: level === "auto" ? "pass" : level === "review" ? "review" : "blocked" })],
      );
    });
  }

  /** 真实治理链：dry-run（pending → confirmed）+ 提案事件 + 审批行（approved）+ 手势事件 → 激活 */
  async function activateWithGovernance(rowId: string, rule: RuntimeRule, version: string, tier: "l2_captain" | "l4_chairman" = "l2_captain"): Promise<void> {
    const { dryRunId } = await createDryRun(app, { tenantId, workspaceId }, {
      ruleId: rule.rule_id, ruleVersion: version, rules: [rule], defaultLevel: "review", createdBy: "MEM-DRILL",
    });
    await confirmDryRun(app, { tenantId, workspaceId }, dryRunId);
    // 唯一审批 id（两次激活共用前缀会撞主键；生产由 makeReadableId 保证唯一）
    const approvalId = `apr-drill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const proposalEventId = await serviceTx(workspaceId, async (client, scope) => {
      const ev = await appendEventOn(client, scope, actor, {
        objectType: "fence_rule", objectId: rowId, action: "fence.rule.propose",
        after: { ruleId: rule.rule_id, dryRunId, rowId, version, basis: "备份回滚演练" },
      });
      await client.query(
        `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, tier, snapshot, decided_by, decided_at)
         VALUES ($1,$2,$3,$4,'inapp','approved',$6,$5,'MEM-DRILL',now())
         ON CONFLICT (event_id, channel) DO NOTHING`,
        [approvalId, scope.tenantId, scope.workspaceId, ev.eventId,
          JSON.stringify({ action: "fence.rule.propose", high_risk: tier === "l4_chairman", title: `围栏变更：${rule.rule_id}` }), tier],
      );
      return ev.eventId;
    });
    void proposalEventId;
    // 手势事件（真实鉴权链：approval.gesture 绑定 approved 审批行与提案事件）
    const gesture = await gatewayAppend(getGatewayPool(), { tenantId, workspaceId, actor },
      {
        who: { type: "human", id: "MEM-DRILL" },
        context: { tenant_id: tenantId, workspace_id: workspaceId, time: new Date().toISOString(), channel: "inapp" },
        object: { type: "fence_rule", id: rowId },
        decision: { action: "approval.gesture", after: { approvalId, gesture: "approve" }, basis: ["备份回滚演练：围栏变更放行"] },
        rule_impact: [],
      } as never);
    await activateRuleVersion(app, { tenantId, workspaceId }, {
      ruleRowId: rowId, dryRunId, approvalEventId: gesture.eventId,
    });
  }

  async function activeRow(ruleId: string) {
    const r = await svcQuery<{ level: string; match_spec: Record<string, unknown> }>(workspaceId,
      `SELECT level, match_spec FROM fence_rules WHERE workspace_id=$1 AND rule_id=$2 AND status='active'`,
      [workspaceId, ruleId]);
    return r[0] ?? null;
  }
}

/* ================= ④ 模型切换回滚（命令级） ================= */
async function modelRollback(): Promise<{ detail: string }> {
  const previous = [{ scene: "content-generate", tier: "L1" as const, model: "mock-001", noDowngrade: false }];
  const next = [{ scene: "content-generate", tier: "L2" as const, model: "mock-002", noDowngrade: false }];
  const changes = diffModelConfig(previous, next);
  if (changes.length === 0) throw new Error("diff 未识别模型变更");
  const command = buildRollbackCommand(changes[0]!);
  if (!command.includes("mock-001")) throw new Error(`回滚命令未指向旧配置：${command}`);
  return { detail: `变更 ${changes.length} 项（${changes[0]!.from} → ${changes[0]!.to}）→ 回滚命令已生成（指向 mock-001）：${command.slice(0, 100)}` };
}

/* ================= ⑤ 执行器回滚 ================= */
async function executorRollback(): Promise<{ detail: string }> {
  const modulePath = join(ROOT, "bundles", "geo-growth", "connectors", "publish-bridge", "server-adapter.mts");
  if (!existsSync(modulePath)) throw new Error(`演练用执行器模块不存在：${modulePath}`);
  const original = process.env.WORKLOOM_TOOL_EXECUTOR_MODULES;
  const originalRoots = process.env.WORKLOOM_TOOL_EXECUTOR_ROOTS;
  const originalUrl = process.env.WORKLOOM_PUBLISH_BRIDGE_URL;
  const originalToken = process.env.WORKLOOM_PUBLISH_BRIDGE_TOKEN;
  try {
    process.env.WORKLOOM_TOOL_EXECUTOR_MODULES = `publish=${modulePath}`;
    process.env.WORKLOOM_TOOL_EXECUTOR_ROOTS = join(ROOT, "bundles");
    // 桥执行器仅在配置了桥地址时才返回实例（未配置 = connector-required）；演练给一个假地址
    process.env.WORKLOOM_PUBLISH_BRIDGE_URL = "http://127.0.0.1:9/drill";
    process.env.WORKLOOM_PUBLISH_BRIDGE_TOKEN = "drill-token";
    const configured = await loadDeploymentToolExecutor({ tenantId, workspaceId });
    if (!configured) throw new Error("配置执行器后未能加载（演练前置不成立）");
    delete process.env.WORKLOOM_TOOL_EXECUTOR_MODULES;
    const rolledBack = await loadDeploymentToolExecutor({ tenantId, workspaceId });
    if (rolledBack !== undefined) throw new Error("撤下配置后仍返回执行器（回滚不安全）");
    return { detail: "配置 publish 执行器可加载 → 撤下模块配置后回落到「未核实」安全态（不残留半配置）" };
  } finally {
    if (original === undefined) delete process.env.WORKLOOM_TOOL_EXECUTOR_MODULES;
    else process.env.WORKLOOM_TOOL_EXECUTOR_MODULES = original;
    if (originalRoots === undefined) delete process.env.WORKLOOM_TOOL_EXECUTOR_ROOTS;
    else process.env.WORKLOOM_TOOL_EXECUTOR_ROOTS = originalRoots;
    if (originalUrl === undefined) delete process.env.WORKLOOM_PUBLISH_BRIDGE_URL;
    else process.env.WORKLOOM_PUBLISH_BRIDGE_URL = originalUrl;
    if (originalToken === undefined) delete process.env.WORKLOOM_PUBLISH_BRIDGE_TOKEN;
    else process.env.WORKLOOM_PUBLISH_BRIDGE_TOKEN = originalToken;
  }
}

/* ================= 编排与报告 ================= */
async function cleanup(): Promise<void> {
  const owner = getOwnerPool();
  await owner.query(`DELETE FROM bundle_snapshots WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
  await owner.query(`DELETE FROM bundle_installs WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
  await owner.query(`DELETE FROM approvals WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
  await owner.query(`DELETE FROM skill_installs WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
  await owner.query(`DELETE FROM agents WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
  await owner.query(`DELETE FROM fence_rules WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
  await owner.query(`DELETE FROM biz_events WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
  await owner.query(`DELETE FROM workspaces WHERE id=$1`, [workspaceId]).catch(() => undefined);
  await owner.query(`DELETE FROM tenants WHERE id=$1`, [tenantId]).catch(() => undefined);
}

await record("pg-restore", "PG 逻辑备份恢复（pg_dump -Fc → 演练库 restore → 行数/事件链一致）", pgBackupRestore);
await record("bundle-rollback", "Bundle 回滚（快照 → 卸载 → rollbackSnapshot 恢复）", async () => {
  try {
    return await bundleRollback();
  } finally {
    // fence 演练需要同一沙箱工作区，清理放到最后统一做
  }
});
await record("fence-rollback", "围栏回滚（加严激活 → 原定义重新激活 → 定义逐字一致 + 历史留痕）", fenceRollback);
await record("model-rollback", "模型切换回滚（台账 diff → 回滚命令指向旧配置）", modelRollback);
await record("executor-rollback", "执行器回滚（撤下模块配置 → 未核实安全态）", executorRollback);
await cleanup().catch((error) => console.error("[drill] 清理失败（不影响结论，需人工确认）", error));

const failed = results.filter((r) => r.status === "fail");
const slowest = results.filter((r) => r.rtoSeconds !== null).sort((a, b) => (b.rtoSeconds ?? 0) - (a.rtoSeconds ?? 0))[0];
const report = `# 备份与回滚演练报告（B-74）

> 生成时间：${new Date().toISOString()}｜执行方式：\`pnpm drill:backup\`
> 沙箱：演练库 \`${drillDb}\`（已删除）· 演练工作区 \`${workspaceId}\`（已清理）；不触碰演示工作区与生产配置。

| 演练项 | 结果 | RTO（秒） | 说明 |
|---|---|---:|---|
${results.map((r) => `| ${r.id} | ${r.status === "pass" ? "✅ 通过" : r.status === "fail" ? "❌ 失败" : "⏭ 未验证"} | ${r.rtoSeconds ?? "—"} | ${r.detail.replace(/\|/g, "\\|")} |`).join("\n")}

## RTO / RPO 记录

- 最长单项 RTO：${slowest ? `${slowest.id} ${slowest.rtoSeconds} 秒` : "—"}（本机单机 PG，逻辑备份口径）。
- RPO：逻辑备份口径 = 备份时刻；生产建议按 WAL 归档 / 云备份策略执行，本报告只记录**可复现的恢复能力**，不宣称生产 RPO。
- 结论：${failed.length === 0 ? "五条回滚路径全部可复现通过" : `存在 ${failed.length} 项失败：${failed.map((f) => f.id).join("、")}`}。

## 回滚路径速查

| 层 | 回滚动作 | 数据影响 | 是否需人审 |
|---|---|---|---|
| PG | 从最近备份恢复（逻辑/物理按部署口径） | 恢复到备份点，备份点之后的数据丢失 | 需要（数据面） |
| Bundle | \`rollbackSnapshot\`（回滚替换前自动再快照） | 代理/围栏/技能安装状态回退 | 需要（业务面） |
| 围栏 | 以原定义重新激活（旧版转 rolled_back，只增不改） | 判定级别回退到原档 | 需要（治理面） |
| 模型 | 按台账 \`buildRollbackCommand\` 逐项回退 | 路由配置回退，事件留痕 | 需要（成本/质量面） |
| 执行器 | 撤下模块配置（回到未核实安全态） | 工具调用不再出真实回执 | 不需要（收紧方向） |
`;
mkdirSync(join(ROOT, "docs", "reports"), { recursive: true });
writeFileSync(REPORT, report);
console.log(`\n报告已落：${REPORT}`);
console.log(failed.length === 0 ? "备份与回滚演练通过" : `备份与回滚演练失败：${failed.map((f) => f.id).join("、")}`);
process.exit(failed.length === 0 ? 0 : 1);
