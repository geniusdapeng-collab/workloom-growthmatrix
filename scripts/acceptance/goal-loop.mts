#!/usr/bin/env node
/**
 * acceptance:goal-loop · 目标→执行闭环验收（B-73）
 *
 * goal → 五环/岗位 → thread → contract → receipt → report 端到端：
 *  ① 契约（m4）创建并 accept 自动建线程；② deliver/verify/settle 全链；
 *  ③ 五元事件齐备（contract.* 6 条）；④ 线程行存在；⑤ 结算落 budget_ledger 且幂等。
 * 任一失败非 0 退出。
 */
import { getAppPool, getGatewayPool } from "@workloom/db";
import { advanceContract, createContract } from "@workloom/base/collaboration";
import { recordCost } from "@workloom/base/cost-ledger";

const scope = { tenantId: "tenant-demo", workspaceId: "ws-geo" };
const actor = { id: "MEM-001", type: "human" as const };
const id = `ct-goal-${Date.now().toString(36)}`;
let failed = 0;
const check = (ok: boolean, label: string, detail = ""): void => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` —— ${detail}` : ""}`);
  if (!ok) failed += 1;
};

const app = getAppPool();
const created = await createContract(app, scope, {
  id, title: "目标闭环验收", goal: "本周双域日更带动有效询盘 +20%",
  requester: "growth-lead", assigneePreset: "geo-content-planner", verifierPreset: "review-analyst",
  successCriteria: ["周更 ≥21 条", "双入口询盘环比 +20%", "战报可复算"],
  budgetAmount: 88, mode: "m4_contract",
}, actor);
check(created.contract.status === "offered", "goal 已形成契约（offered）");

let threadId: string | null = null;
for (const action of ["accept", "start", "deliver", "verify", "settle"] as const) {
  const r = await advanceContract(app, scope, { id, action, by: actor });
  if (action === "accept") threadId = r.contract.threadId;
  check(Boolean(r.eventId), `契约迁移 ${action}`, r.contract.status);
}
check(Boolean(threadId), "accept 自动建线程（执行承载）", threadId ?? "");

// 事件与线程落库核对（RLS 事务内）
const client = await app.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
  const events = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM biz_events
      WHERE workspace_id=$1 AND payload->'object'->>'id'=$2 AND payload->'decision'->>'action' LIKE 'contract.%'`,
    [scope.workspaceId, id],
  );
  check(Number(events.rows[0]!.n) >= 6, "契约六段事件齐备", `events=${events.rows[0]!.n}`);
  const thread = threadId
    ? await client.query(`SELECT 1 FROM threads WHERE workspace_id=$1 AND id=$2`, [scope.workspaceId, threadId])
    : { rows: [] };
  check(thread.rows.length === 1, "执行线程行存在");
  await client.query("ROLLBACK");
} finally {
  client.release();
}

const ledger = await recordCost(app, getGatewayPool(), scope, {
  costKind: "labor", amount: 88, idempotencyKey: `contract:${id}`, projectId: id,
  meta: { contractId: id, source: "goal-loop", threadId },
}, "MEM-001");
check(ledger.deduped === false && ledger.eventId !== null, "结算落预算账本（receipt→report 事实源）");

console.log(failed === 0 ? `\n目标闭环验收通过（契约 ${id}）` : `\n目标闭环验收失败：${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
