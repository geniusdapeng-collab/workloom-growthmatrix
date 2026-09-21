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

  it("创建 → offered，事件 contract.offer 落账", async () => {
    const { contract, eventId } = await createContract(app, scope, {
      id: contractId, title: "B-37 契约持久化用例", goal: "验证契约状态机与事件留痕",
      requester: "growth-lead", assigneePreset: "geo-content-planner", verifierPreset: "review-analyst",
      successCriteria: ["状态按状态机推进", "每次迁移有事件回执"],
      budgetAmount: 120, mode: "m4_contract", threadId: "T-G01", bundleScope: ["geo-growth"], matrixRefs: ["mx-1"],
    }, actor);
    expect(contract).toMatchObject({ id: contractId, status: "offered", threadId: "T-G01", bundleScope: ["geo-growth"] });
    expect(eventId).toMatch(/^E-/);
  });

  it("状态机：accept→start→deliver→verify→settle；非法跳步拒绝", async () => {
    await expect(advanceContract(app, scope, { id: contractId, action: "settle", by: actor }))
      .rejects.toMatchObject({ code: "BAD_STATE" });
    for (const action of ["accept", "start", "deliver", "verify", "settle"] as const) {
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
});
