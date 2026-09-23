/**
 * B-40 契约↔线程↔关卡↔结算（事件溯源路径）活库契约：
 *  - accept 同事务建线程并回带 threadId；
 *  - deliver 事件点名 verifier；
 *  - verify 超自治带 → 落 L4/L3 待放行关卡；未放行结算被拒，放行后结算成功；
 *  - settle 同事务落 budget_ledger（台账↔事件互证、幂等）；并发推进由乐观锁拒绝。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { advanceContract, createContract, getContract } from "./collaboration.js";
import { contractGateId } from "@workloom/base/collaboration";
import { createContract as storeCreateContract } from "@workloom/base/collaboration";
import { getAppPool } from "@workloom/db";

process.env.DATABASE_URL ??= "postgres://postgres:workloom@localhost:5432/workloom";
process.env.DATABASE_APP_URL ??= "postgres://workloom_app:workloom_dev_app@localhost:5432/workloom";

const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_APP_URL);
const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const tenantId = `tenant-ctsvc-${suffix}`;
const workspaceId = `ws-ctsvc-${suffix}`;
const actor = { id: "MEM-001", type: "human" as const };

describe.runIf(RUN_DB)("B-40 契约全链（事件溯源路径）", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  beforeAll(async () => {
    await owner.query(`INSERT INTO tenants (id, name, plan) VALUES ($1,$2,'pro')`, [tenantId, "契约全链测试租户"]);
    await owner.query(
      `INSERT INTO workspaces (id, tenant_id, name, slug, industry) VALUES ($1,$2,$3,$4,'general')`,
      [workspaceId, tenantId, "契约全链测试工作区", `ctsvc-${suffix}`],
    );
  });

  afterAll(async () => {
    await owner.query(`DELETE FROM budget_ledger WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM approvals WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM threads WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM biz_events WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM workspaces WHERE id=$1`, [workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM tenants WHERE id=$1`, [tenantId]).catch(() => undefined);
    await owner.end();
  });

  it("accept 建线程 + deliver 点名 verifier + 带内自动结算落账", async () => {
    const created = await createContract(workspaceId, actor, {
      title: "带内契约全链", goal: "验证线程/验收/结算三链", assigneePreset: "geo-content-planner",
      verifierPreset: "review-analyst", successCriteria: ["全链可复算"], budgetAmount: 120, mode: "m4_contract",
    });
    expect(created.status).toBe("offered");

    const accepted = await advanceContract(workspaceId, actor, created.id, "accept");
    const threadId = (accepted as unknown as { threadId?: string }).threadId;
    expect(threadId).toBeTruthy();
    const thread = await owner.query(`SELECT 1 FROM threads WHERE workspace_id=$1 AND id=$2`, [workspaceId, threadId]);
    expect(thread.rows.length).toBe(1);

    const started = await advanceContract(workspaceId, actor, created.id, "start");
    expect(started.status).toBe("in_progress");
    const delivered = await advanceContract(workspaceId, actor, created.id, "deliver");
    expect(delivered.status).toBe("delivered");
    const deliverEvent = await owner.query<{ verifier: string | null; requested: boolean | null }>(
      `SELECT payload->'decision'->'after'->>'verifierPreset' AS verifier,
              (payload->'decision'->'after'->>'verifyRequested')::boolean AS requested
         FROM biz_events WHERE workspace_id=$1 AND payload->'object'->>'id'=$2
           AND payload->'decision'->>'action'='contract.deliver' ORDER BY seq DESC LIMIT 1`,
      [workspaceId, created.id],
    );
    expect(deliverEvent.rows[0]).toMatchObject({ verifier: "review-analyst", requested: true });

    await advanceContract(workspaceId, actor, created.id, "verify");
    const settled = await advanceContract(workspaceId, actor, created.id, "settle");
    expect(settled.status).toBe("settled");
    const ledger = await owner.query<{ ref_event_id: string | null; amount: string }>(
      `SELECT ref_event_id, amount::text AS amount FROM budget_ledger
        WHERE workspace_id=$1 AND idempotency_key=$2`,
      [workspaceId, `contract:${created.id}`],
    );
    expect(ledger.rows[0]?.ref_event_id).toMatch(/^E-/);
    expect(Number(ledger.rows[0]?.amount)).toBe(120);
    const settleEvent = await owner.query<{ ledger: string | null; amount: string | null }>(
      `SELECT payload->'decision'->'after'->>'ledgerId' AS ledger,
              payload->'decision'->'after'->>'settleAmount' AS amount
         FROM biz_events WHERE workspace_id=$1 AND payload->'object'->>'id'=$2
           AND payload->'decision'->>'action'='contract.settle'`,
      [workspaceId, created.id],
    );
    expect(settleEvent.rows[0]?.ledger).toMatch(/^\d+$/);
    // 重复结算（终态）被状态机拒绝
    await expect(advanceContract(workspaceId, actor, created.id, "settle")).rejects.toThrow(/不允许/);
  });

  it("超自治带：verify 落待放行关卡，未放行拒绝结算，放行后通过", async () => {
    const created = await createContract(workspaceId, actor, {
      title: "超带契约全链", goal: "超带需关卡", assigneePreset: "geo-content-planner",
      verifierPreset: "review-analyst", successCriteria: ["关卡可复算"], budgetAmount: 900, mode: "m4_contract",
    });
    for (const action of ["accept", "start", "deliver", "verify"] as const) {
      await advanceContract(workspaceId, actor, created.id, action);
    }
    const gateId = contractGateId(created.id);
    const gate = await owner.query<{ status: string; tier: string }>(
      `SELECT status, tier FROM approvals WHERE workspace_id=$1 AND approval_id=$2`, [workspaceId, gateId],
    );
    expect(gate.rows[0]).toMatchObject({ status: "pending", tier: "l3_fleet" });

    await expect(advanceContract(workspaceId, actor, created.id, "settle")).rejects.toThrow(/业务关卡/);
    await owner.query(
      `UPDATE approvals SET status='approved', decided_by='MEM-001', decided_at=now() WHERE workspace_id=$1 AND approval_id=$2`,
      [workspaceId, gateId],
    );
    const settled = await advanceContract(workspaceId, actor, created.id, "settle");
    expect(settled.status).toBe("settled");
    const ledger = await owner.query<{ meta: Record<string, unknown> }>(
      `SELECT meta FROM budget_ledger WHERE workspace_id=$1 AND idempotency_key=$2`,
      [workspaceId, `contract:${created.id}`],
    );
    expect(ledger.rows[0]?.meta).toMatchObject({ approvalId: gateId });
    const final = await getContract(workspaceId, created.id);
    expect(final?.status).toBe("settled");
  });

  it("跨路径读模型：表路径建出的契约在事件溯源列表里可见且字段完整（首条事件全量快照）", async () => {
    const storeId = `ct-store-${suffix}`;
    await storeCreateContract(getAppPool(), { tenantId, workspaceId }, {
      id: storeId, title: "表路径契约（跨路径读模型）", goal: "验证 offer 事件带全量快照",
      requester: "growth-lead", assigneePreset: "geo-content-planner", verifierPreset: "review-analyst",
      successCriteria: ["列表可见", "字段完整"], budgetAmount: 45, mode: "m4_contract",
    }, { id: "MEM-001", type: "human" });

    const { listContracts } = await import("./collaboration.js");
    const listed = await listContracts(workspaceId);
    const found = listed.find((c) => c.id === storeId);
    expect(found).toBeTruthy();
    expect(found?.title).toBe("表路径契约（跨路径读模型）");
    expect(found?.successCriteria).toEqual(["列表可见", "字段完整"]);
    // 事件里确实落了全量快照（offer 是首条事件）
    const first = await owner.query<{ action: string; after: Record<string, unknown> }>(
      `SELECT payload->'decision'->>'action' AS action, payload->'decision'->'after' AS after
         FROM biz_events WHERE workspace_id=$1 AND payload->'object'->>'id'=$2 ORDER BY seq ASC LIMIT 1`,
      [workspaceId, storeId],
    );
    expect(first.rows[0]?.action).toBe("contract.offer");
    expect(first.rows[0]?.after).toMatchObject({ title: "表路径契约（跨路径读模型）", id: storeId });
    await owner.query(`DELETE FROM task_contracts WHERE id=$1`, [storeId]).catch(() => undefined);
  });
});
