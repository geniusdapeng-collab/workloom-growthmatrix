#!/usr/bin/env node
/**
 * acceptance:collab · 协作闭环验收（B-41）
 *
 * 用法：tsx --env-file=.env scripts/acceptance/collab-loop.mts
 * 覆盖：契约创建 → accept → start → deliver → verify → settle；每步断言状态与事件；
 *       任一断言失败非 0 退出（供发布前检查引用）。
 */
import { getAppPool, getGatewayPool } from "@workloom/db";
import { advanceContract, createContract, listContracts } from "@workloom/base/collaboration";
import { recordCost } from "@workloom/base/cost-ledger";

const scope = { tenantId: "tenant-demo", workspaceId: "ws-geo" };
const actor = { id: "MEM-001", type: "human" as const };
const id = `ct-accept-${Date.now().toString(36)}`;
let failed = 0;
const check = (ok: boolean, label: string, detail = ""): void => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` —— ${detail}` : ""}`);
  if (!ok) failed += 1;
};

const app = getAppPool();
const created = await createContract(app, scope, {
  id, title: "协作闭环验收契约", goal: "四段交接 + 验收 + 结算全链贯通",
  requester: "growth-lead", assigneePreset: "geo-content-planner", verifierPreset: "review-analyst",
  successCriteria: ["每步有事件回执", "验收后才结算", "结论可复跑"],
  budgetAmount: 66, mode: "m4_contract", threadId: `T-${id.slice(-5)}`,
}, actor);
check(created.contract.status === "offered" && /^E-/.test(created.eventId), "契约已发出（offered + 事件）", created.eventId);

const steps = ["accept", "start", "deliver", "verify", "settle"] as const;
let acceptedThread: string | null = null;
for (const action of steps) {
  const r = await advanceContract(app, scope, { id, action, by: actor });
  check(Boolean(r.eventId), `契约迁移 ${action}`, r.contract.status);
  if (action === "accept") {
    acceptedThread = r.contract.threadId;
    check(Boolean(acceptedThread), "accept 自动建线程（契约↔线程）", acceptedThread ?? "");
  }
}
const final = (await listContracts(app, scope, { status: "settled", limit: 200 })).find((c) => c.id === id);
check(final?.status === "settled", "契约最终状态 settled");
// B-40：结算写预算账本（幂等：同 idempotencyKey 第二次去重）
const gateway = getGatewayPool();
const ledger1 = await recordCost(app, gateway, scope, {
  costKind: "labor", amount: 66, idempotencyKey: `contract:${id}`, projectId: id,
  meta: { contractId: id, threadId: acceptedThread, source: "collab-loop" },
});
const ledger2 = await recordCost(app, gateway, scope, {
  costKind: "labor", amount: 66, idempotencyKey: `contract:${id}`, projectId: id,
});
check(ledger1.deduped === false && ledger2.deduped === true, "结算写预算账本且幂等去重");

console.log(failed === 0
  ? `\n协作闭环验收通过（契约 ${id}）`
  : `\n协作闭环验收失败：${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
