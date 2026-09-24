/**
 * B-37 契约持久化活库契约：状态机推进、非法迁移拒绝、事件留痕、RLS 隔离、删除不授予。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { advanceContract, ContractStoreError, createContract, getContract, listContracts } from "./store.js";

process.env.DATABASE_APP_URL ??= "postgres://workloom_app:workloom_dev_app@localhost:5432/workloom";
process.env.DATABASE_URL ??= "postgres://postgres:workloom@localhost:5432/workloom";
const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_APP_URL);
const scope = { tenantId: "tenant-demo", workspaceId: "ws-geo" };
const actor = { id: "MEM-001", type: "human" as const };
const contractId = `ct-e2e-${Date.now().toString(36)}`;

describe.runIf(RUN_DB)("B-37 任务契约持久化", () => {
  const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL });
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  beforeAll(() => undefined);
  afterAll(async () => {
    await owner.query(`DELETE FROM task_contracts WHERE id=$1`, [contractId]).catch(() => undefined);
    await app.end();
    await owner.end();
  });

  it("创建 → draft（初始为草稿），事件 contract.create 落账", async () => {
    const { contract, eventId } = await createContract(app, scope, {
      id: contractId, title: "B-37 契约持久化用例", goal: "验证契约状态机与事件留痕",
      requester: "growth-lead", assigneePreset: "geo-content-planner", verifierPreset: "review-analyst",
      successCriteria: ["状态按状态机推进", "每次迁移有事件回执"],
      budgetAmount: 120, mode: "m4_contract", threadId: "T-G01", bundleScope: ["geo-growth"], matrixRefs: ["mx-1"],
    }, actor);
    // 2026-09-24 修复（H-23）：创建=草稿；发放是显式迁移（advance offer），不再"创建即 offer"
    expect(contract).toMatchObject({ id: contractId, status: "draft", threadId: "T-G01", bundleScope: ["geo-growth"] });
    expect(eventId).toMatch(/^E-/);
  });

  it("状态机：accept→start→deliver→verify→settle；非法跳步拒绝", async () => {
    await expect(advanceContract(app, scope, { id: contractId, action: "settle", by: actor }))
      .rejects.toMatchObject({ code: "BAD_STATE" });
    // draft 起步：先显式发放（offer），再走 accept→…→settle
    for (const action of ["offer", "accept", "start", "deliver", "verify", "settle"] as const) {
      const r = await advanceContract(app, scope, { id: contractId, action, by: actor });
      expect(r.contract.status).not.toBeUndefined();
    }
    const final = await getContract(app, scope, contractId);
    expect(final?.status).toBe("settled");
    const list = await listContracts(app, scope, { status: "settled", limit: 100 });
    expect(list.some((c) => c.id === contractId)).toBe(true);
  });

  it("RLS：未设 GUC 查询 0 行；app 角色无 DELETE 权限（只增不改）", async () => {
    const naked = await app.query(`SELECT count(*)::int AS n FROM task_contracts WHERE id=$1`, [contractId]);
    expect(naked.rows[0]!.n).toBe(0);
    await expect(app.query(`DELETE FROM task_contracts WHERE id=$1`, [contractId])).rejects.toThrow(/permission denied/i);
  });

  it("未知契约 / 非法输入拒绝", async () => {
    await expect(advanceContract(app, scope, { id: "ct-not-exist", action: "accept", by: actor }))
      .rejects.toBeInstanceOf(ContractStoreError);
    await expect(createContract(app, scope, {
      id: `${contractId}-bad`, title: "", goal: "x", requester: "a", assigneePreset: "b", verifierPreset: "c",
      successCriteria: [], mode: "m4_contract",
    }, actor)).rejects.toMatchObject({ code: "BAD_INPUT" });
  });

  it("B-40：settle 同事务落预算账本（台账↔计量事件互证，幂等键 contract:<id>）", async () => {
    const id = `ct-settle-inband-${Date.now().toString(36)}`;
    await createContract(app, scope, {
      id, title: "带内结算契约", goal: "带内结算不需关卡", requester: "growth-lead",
      assigneePreset: "geo-content-planner", verifierPreset: "review-analyst",
      successCriteria: ["结算落账"], budgetAmount: 88, mode: "m4_contract",
    }, actor);
    // 创建=草稿（2026-09-24 修复）：先显式发放，再走后续状态机
    for (const action of ["offer", "accept", "start", "deliver", "verify", "settle"] as const) {
      await advanceContract(app, scope, { id, action, by: actor });
    }
    const row = await owner.query<{ id: string; ref_event_id: string | null; amount: string; meta: Record<string, unknown> }>(
      `SELECT id, ref_event_id, amount::text AS amount, meta FROM budget_ledger
        WHERE workspace_id=$1 AND idempotency_key=$2`,
      [scope.workspaceId, `contract:${id}`],
    );
    expect(row.rows[0]).toBeTruthy();
    expect(row.rows[0]!.ref_event_id).toMatch(/^E-/);
    expect(Number(row.rows[0]!.amount)).toBe(88);
    const gate = await owner.query(
      `SELECT 1 FROM approvals WHERE workspace_id=$1 AND approval_id=$2`,
      [scope.workspaceId, `apr-${id.toLowerCase()}-settle`],
    );
    expect(gate.rows.length).toBe(0); // 带内不建关卡
    await owner.query(`DELETE FROM budget_ledger WHERE workspace_id=$1 AND idempotency_key=$2`, [scope.workspaceId, `contract:${id}`]);
  });

  it("B-40：超自治带结算必须关卡放行（未放行拒绝，放行后通过）", async () => {
    const id = `ct-settle-overband-${Date.now().toString(36)}`;
    await createContract(app, scope, {
      id, title: "超带结算契约", goal: "超带必须放行", requester: "growth-lead",
      assigneePreset: "geo-content-planner", verifierPreset: "review-analyst",
      successCriteria: ["超带需放行"], budgetAmount: 12000, mode: "m4_contract",
    }, actor);
    for (const action of ["offer", "accept", "start", "deliver", "verify"] as const) {
      await advanceContract(app, scope, { id, action, by: actor });
    }
    const gateId = `apr-${id.toLowerCase()}-settle`;
    const gate = await owner.query<{ status: string; tier: string }>(
      `SELECT status, tier FROM approvals WHERE workspace_id=$1 AND approval_id=$2`, [scope.workspaceId, gateId],
    );
    expect(gate.rows[0]).toMatchObject({ status: "pending", tier: "l4_chairman" }); // >500×10 → L4

    await expect(advanceContract(app, scope, { id, action: "settle", by: actor }))
      .rejects.toMatchObject({ code: "BAD_STATE" });

    await owner.query(
      `UPDATE approvals SET status='approved', decided_by='MEM-001', decided_at=now() WHERE workspace_id=$1 AND approval_id=$2`,
      [scope.workspaceId, gateId],
    );
    const settled = await advanceContract(app, scope, { id, action: "settle", by: actor });
    expect(settled.contract.status).toBe("settled");
    const ledger = await owner.query<{ amount: string; meta: Record<string, unknown> }>(
      `SELECT amount::text AS amount, meta FROM budget_ledger WHERE workspace_id=$1 AND idempotency_key=$2`,
      [scope.workspaceId, `contract:${id}`],
    );
    expect(ledger.rows[0]?.meta).toMatchObject({ approvalId: gateId, contractId: id });
    await owner.query(`DELETE FROM budget_ledger WHERE workspace_id=$1 AND idempotency_key=$2`, [scope.workspaceId, `contract:${id}`]);
    await owner.query(`DELETE FROM approvals WHERE workspace_id=$1 AND approval_id=$2`, [scope.workspaceId, gateId]);
  });
});
