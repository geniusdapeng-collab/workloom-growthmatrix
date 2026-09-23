#!/usr/bin/env node
/**
 * acceptance:gates · 业务关卡放行端到端验收（去审批化的补偿控制）
 *
 * 背景（RDAS 隔离副本通道要求"有意偏离 + 补偿控制"）：本仓按产品所有者口径下线了基座「审批中心」，
 * 基座 RDAS 的 EXP-02（审批中心三手势）在本仓不适用。补偿控制 = 用**业务关卡**把同一份治理责任
 * 压在服务端与业务页面上，本脚本对它做端到端验收：
 *   ① 待放行关卡可见（真实 approvals 队列，L4 分层正确）；
 *   ② 批量放行只放低风险/配额内（L4 与高危留待逐条）→ 手势事件 + gate.batch_release 汇总事件；
 *   ③ 契约超自治带结算必须先过放行关卡（未放行拒绝 → 放行后结算落账本）；
 *   ④ 信任账户降档自动收紧对口自治项（收紧方向免人批）。
 * 沙箱：自建租户/工作区，跑完清理；失败非 0 退出。
 */
import { randomUUID } from "node:crypto";
import { getAppPool, getOwnerPool } from "@workloom/db";
import { defaultCharter } from "@workloom/base/captain";
import { advanceContract, createContract } from "../../apps/server/src/service/collaboration.js";
import { gateLoadMetrics, releaseGatesBatch } from "../../apps/server/src/service/gate-batch.js";
import { runTrustReview } from "../../apps/server/src/service/trust-runtime.js";
import { svcQuery } from "../../apps/server/src/service/events.js";

let failed = 0;
const check = (ok: boolean, label: string, detail = ""): void => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` —— ${detail}` : ""}`);
  if (!ok) failed += 1;
};

const suffix = randomUUID().slice(0, 8);
const tenantId = `tenant-gates-${suffix}`;
const workspaceId = `ws-gates-${suffix}`;
const owner = getOwnerPool();
const app = getAppPool();

try {
  await owner.query(`INSERT INTO tenants (id, name, plan) VALUES ($1,$2,'pro')`, [tenantId, "业务关卡验收租户"]);
  await owner.query(
    `INSERT INTO workspaces (id, tenant_id, name, slug, industry) VALUES ($1,$2,$3,$4,'geo-growth')`,
    [workspaceId, tenantId, "业务关卡验收工作区", `gates-${suffix}`],
  );
  const charter = defaultCharter();
  charter.mode = "active";
  charter.autonomy.caps.price_delta_pct = { label: "价格调整上限", limit: 8 };
  await owner.query(
    `INSERT INTO profiles (workspace_id, tenant_id, industry, archive, forbidden)
     VALUES ($1,$2,'geo-growth',$3,'[]'::jsonb)`,
    [workspaceId, tenantId, JSON.stringify({ industry: "geo-growth", dataMode: "simulated", charter })],
  );

  /* ① 待放行关卡队列：3 条低风险 + 1 条 L4 + 1 条高危 */
  const gates: Array<[string, string, boolean]> = [
    [`apr-g-low1-${suffix}`, "l2_captain", false],
    [`apr-g-low2-${suffix}`, "l2_captain", false],
    [`apr-g-low3-${suffix}`, "l3_fleet", false],
    [`apr-g-l4-${suffix}`, "l4_chairman", true],
    [`apr-g-risk-${suffix}`, "l2_captain", true],
  ];
  for (const [id, tier, highRisk] of gates) {
    await owner.query(
      `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, tier, snapshot)
       VALUES ($1,$2,$3,$4,'inapp','pending',$5,$6)`,
      [id, tenantId, workspaceId, `E-${id}`, tier, JSON.stringify({ title: `关卡 ${id}`, high_risk: highRisk, action: "publish.execute" })],
    );
  }
  const metricsBefore = await gateLoadMetrics(workspaceId, 7);
  check(metricsBefore.pending === 5, "待放行关卡队列可见（5 件）", metricsBefore.summary.slice(0, 60));
  check(metricsBefore.pendingByTier.l4_chairman === 1, "L4 分层正确（董事长级 1 件）");

  /* ② 批量放行：只放低风险/配额内 */
  const released = await releaseGatesBatch(workspaceId, { memberNo: "MEM-G01", role: "owner", id: "mem-gates" }, { quota: 7, sampleRate: 0, seed: 9 });
  check(released.released.length === 3, "批量放行 3 件低风险关卡", released.released.join(","));
  const statuses = await owner.query<{ approval_id: string; status: string }>(
    `SELECT approval_id, status FROM approvals WHERE workspace_id=$1`, [workspaceId],
  );
  const byId = Object.fromEntries(statuses.rows.map((r) => [r.approval_id, r.status]));
  check(byId[`apr-g-l4-${suffix}`] === "pending" && byId[`apr-g-risk-${suffix}`] === "pending", "L4 与高危关卡留待逐条（不批量）");
  const summary = await owner.query<{ after: Record<string, unknown> }>(
    `SELECT payload->'decision'->'after' AS after FROM biz_events
      WHERE workspace_id=$1 AND payload->'decision'->>'action'='gate.batch_release'`,
    [workspaceId],
  );
  check(summary.rows.length === 1 && (summary.rows[0]?.after as { releasedCount?: number }).releasedCount === 3,
    "整批写一条 gate.batch_release 汇总事件（含 seed/留待清单）");
  const gestures = await svcQuery<{ n: string }>(workspaceId,
    `SELECT count(*)::text AS n FROM biz_events WHERE workspace_id=$1 AND payload->'decision'->>'action'='approval.gesture'`,
    [workspaceId]);
  check(Number(gestures[0]?.n ?? 0) === 3, "放行走 review-console 手势链路（approval.gesture ×3）");

  /* ③ 契约超带结算：先关卡后结算 */
  const contract = await createContract(workspaceId, { id: "MEM-G01", type: "human" }, {
    title: "超带契约（关卡放行后结算）", goal: "验证业务关卡与结算串联",
    assigneePreset: "geo-content-planner", verifierPreset: "review-analyst",
    successCriteria: ["未放行拒绝", "放行后落账"], budgetAmount: 900, mode: "m4_contract",
  });
  for (const action of ["accept", "start", "deliver", "verify"] as const) {
    await advanceContract(workspaceId, { id: "MEM-G01", type: "human" }, contract.id, action);
  }
  const gateId = `apr-${contract.id.toLowerCase()}-settle`;
  const gateRow = await owner.query<{ status: string; tier: string }>(
    `SELECT status, tier FROM approvals WHERE workspace_id=$1 AND approval_id=$2`, [workspaceId, gateId]);
  check(gateRow.rows[0]?.status === "pending", "verify 落待放行结算关卡", `${gateId} / ${gateRow.rows[0]?.tier}`);
  let blocked = false;
  try {
    await advanceContract(workspaceId, { id: "MEM-G01", type: "human" }, contract.id, "settle");
  } catch { blocked = true; }
  check(blocked, "未放行时结算被拒（fail-closed）");
  await owner.query(
    `UPDATE approvals SET status='approved', decided_by='MEM-G01', decided_at=now() WHERE workspace_id=$1 AND approval_id=$2`,
    [workspaceId, gateId],
  );
  const settled = await advanceContract(workspaceId, { id: "MEM-G01", type: "human" }, contract.id, "settle");
  check(settled.status === "settled", "放行后结算通过（关卡↔结算全链）");
  const ledger = await svcQuery<{ n: string }>(workspaceId,
    `SELECT count(*)::text AS n FROM budget_ledger WHERE workspace_id=$1 AND idempotency_key=$2`,
    [workspaceId, `contract:${contract.id}`]);
  check(Number(ledger[0]?.n ?? 0) === 1, "结算落预算账本（幂等键 contract:<id>）");

  /* ④ 信任账户：降档自动收紧（收紧方向免人批） */
  for (let i = 0; i < 20; i += 1) {
    await owner.query(
      `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, tier, snapshot, decided_by, decided_at, created_at)
       VALUES ($1,$2,$3,$4,'inapp',$5,'l2_captain',$6,'MEM-G01', now() - interval '1 day', now() - interval '2 days')`,
      [`apr-g-price-${i}-${suffix}`, tenantId, workspaceId, `E-price-${i}-${suffix}`,
        i < 8 ? "approved" : "rejected", JSON.stringify({ action: "price.adjust", title: `价格调整 ${i}` })],
    );
  }
  const review = await runTrustReview(workspaceId, { id: "MEM-G01", type: "human" });
  const price = review.reviewed.find((r) => r.domain === "price");
  check(price?.level === "down" && price.tightened, "信任降档 → 对口自治项自动收紧", price?.tightenedKeys.join(",") ?? "");
} finally {
  await owner.query(`DELETE FROM budget_ledger WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
  await owner.query(`DELETE FROM approvals WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
  await owner.query(`DELETE FROM task_contracts WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
  await owner.query(`DELETE FROM threads WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
  await owner.query(`DELETE FROM profiles WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
  await owner.query(`DELETE FROM workspaces WHERE id=$1`, [workspaceId]).catch(() => undefined);
  await owner.query(`DELETE FROM tenants WHERE id=$1`, [tenantId]).catch(() => undefined);
}

console.log(failed === 0 ? "\n业务关卡放行验收通过（去审批化补偿控制）" : `\n业务关卡放行验收失败：${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
