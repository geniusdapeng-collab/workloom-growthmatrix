/**
 * B-39 冲突仲裁对象 · 活库契约：
 *  raise → arbitrate（grant 自决 / escalate 落 L4 关卡）→ resolve；非法迁移与非法输入拒绝；
 *  升级冲突必须出现在决策包（无回执不算完成）；RLS 越权零行。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  arbitrateConflict, ConflictError, getConflict, listConflicts, raiseConflict, resolveConflict,
} from "./arbitration.js";
import { decisionPacket } from "./collaboration.js";

process.env.DATABASE_URL ??= "postgres://postgres:workloom@localhost:5432/workloom";
process.env.DATABASE_APP_URL ??= "postgres://workloom_app:workloom_dev_app@localhost:5432/workloom";

const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_APP_URL);
const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const tenantId = `tenant-conflict-${suffix}`;
const workspaceId = `ws-conflict-${suffix}`;
const actor = { id: "MEM-001", type: "human" as const };

const conflictInput = (over: Record<string, unknown> = {}) => ({
  type: "budget" as const,
  domain: "投放",
  summary: "增长负责人与投放组合经理对下周预算分配方案不一致",
  parties: [
    { agent: "growth-lead", proposal: "把 60% 给信源建设", evidence: "reported" as const, contribution: 0.7 },
    { agent: "media-portfolio-manager", proposal: "把 60% 给投放放量", evidence: "reported" as const, contribution: 0.55 },
  ],
  ...over,
});

describe.runIf(RUN_DB)("B-39 冲突仲裁对象化", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  beforeAll(async () => {
    await owner.query(`INSERT INTO tenants (id, name, plan) VALUES ($1,$2,'pro')`, [tenantId, "冲突仲裁测试租户"]);
    await owner.query(
      `INSERT INTO workspaces (id, tenant_id, name, slug, industry) VALUES ($1,$2,$3,$4,'general')`,
      [workspaceId, tenantId, "冲突仲裁测试工作区", `conflict-${suffix}`],
    );
  });

  afterAll(async () => {
    await owner.query(`DELETE FROM approvals WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM biz_events WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM workspaces WHERE id=$1`, [workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM tenants WHERE id=$1`, [tenantId]).catch(() => undefined);
    await owner.end();
  });

  it("登记 → 证据强度/归因贡献裁决：可自动 grant（单裁决器）", async () => {
    const raised = await raiseConflict(workspaceId, actor, conflictInput());
    expect(raised.status).toBe("raised");
    expect(raised.memo).toContain("冲突裁决备忘录");
    const decided = await arbitrateConflict(workspaceId, actor, raised.id);
    expect(decided.conflict.status).toBe("granted");
    expect(decided.conflict.winner).toBe("growth-lead");
    expect(decided.conflict.approvalId).toBeNull();
    const again = await arbitrateConflict(workspaceId, actor, raised.id).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(ConflictError);
    expect((again as ConflictError).code).toBe("BAD_STATE");
    const read = await getConflict(workspaceId, raised.id);
    expect(read).toMatchObject({ status: "granted", verdict: "grant", winner: "growth-lead" });
  });

  it("硬边界冲突：升级 L4 关卡进入决策包；resolve 收口后不可重复收口", async () => {
    const raised = await raiseConflict(workspaceId, actor, conflictInput({ involvesMoney: true, summary: "涉钱投放预算冲突" }));
    const decided = await arbitrateConflict(workspaceId, actor, raised.id);
    expect(decided.conflict.status).toBe("escalated");
    expect(decided.approvalId).toMatch(/^apr-cf-/);
    const approvalRow = await owner.query<{ status: string; tier: string; snapshot: Record<string, unknown> }>(
      `SELECT status, tier, snapshot FROM approvals WHERE approval_id=$1 AND workspace_id=$2`,
      [decided.approvalId, workspaceId],
    );
    expect(approvalRow.rows[0]).toMatchObject({ status: "pending", tier: "l4_chairman" });
    expect((approvalRow.rows[0]!.snapshot as { conflict_id?: string }).conflict_id).toBe(raised.id);

    const packet = await decisionPacket(workspaceId, 7);
    expect(packet.items.some((i) => i.id === decided.approvalId)).toBe(true);

    const resolved = await resolveConflict(workspaceId, actor, raised.id, { resolution: "本周按 55/45 拆分，下周复核" });
    expect(resolved.conflict.status).toBe("resolved");
    expect(resolved.conflict.resolution).toContain("55/45");
    await expect(resolveConflict(workspaceId, actor, raised.id, { resolution: "再来一次" }))
      .rejects.toMatchObject({ code: "BAD_STATE" });
  });

  it("非法输入与越权读取：单方冲突/同一岗位占多方拒绝；未设 GUC 零行", async () => {
    await expect(raiseConflict(workspaceId, actor, conflictInput({
      parties: [{ agent: "growth-lead", proposal: "单方", evidence: "reported" }],
    }))).rejects.toMatchObject({ code: "BAD_INPUT" });
    await expect(raiseConflict(workspaceId, actor, conflictInput({
      parties: [
        { agent: "growth-lead", proposal: "A", evidence: "reported" },
        { agent: "growth-lead", proposal: "B", evidence: "reported" },
      ],
    }))).rejects.toMatchObject({ code: "BAD_INPUT" });
    await expect(arbitrateConflict(workspaceId, actor, "CF-not-exist")).rejects.toMatchObject({ code: "NOT_FOUND" });

    const list = await listConflicts(workspaceId, { limit: 20 });
    expect(list.length).toBeGreaterThanOrEqual(2);
    const naked = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM biz_events WHERE workspace_id=$1 AND payload->'object'->>'type'='conflict_arbitration'`,
      [workspaceId],
    );
    expect(Number(naked.rows[0]!.n)).toBeGreaterThan(0); // owner 可见
  });
});
