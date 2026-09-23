/**
 * B-70 业务关卡减负 · 活库契约：
 *  ① 批量放行只放低风险/配额内；L4 与高危留待（状态仍 pending）；
 *  ② 整批写一条 gate.batch_release 汇总事件（含 seed/抽检/留待，可复盘）；
 *  ③ H1 仪表读 approvals 行（今日裁决量、均时长、超龄）；
 *  ④ 放行后围栏/事件链路仍走 review-console（approval.gesture 事件在场）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { gateLoadMetrics, releaseGatesBatch } from "./gate-batch.js";

process.env.DATABASE_URL ??= "postgres://postgres:workloom@localhost:5432/workloom";
process.env.DATABASE_APP_URL ??= "postgres://workloom_app:workloom_dev_app@localhost:5432/workloom";
process.env.DATABASE_GATEWAY_URL ??= "postgres://workloom_gateway:workloom_dev_gateway@localhost:5432/workloom";

const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_APP_URL);
const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const tenantId = `tenant-gate-${suffix}`;
const workspaceId = `ws-gate-${suffix}`;
const actor = { memberNo: "MEM-G01", role: "owner" as const, id: `mem-gate-${suffix}` };

describe.runIf(RUN_DB)("B-70 业务关卡批量放行与 H1 仪表", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  beforeAll(async () => {
    await owner.query(`INSERT INTO tenants (id, name, plan) VALUES ($1,$2,'pro')`, [tenantId, "关卡减负测试租户"]);
    await owner.query(
      `INSERT INTO workspaces (id, tenant_id, name, slug, industry) VALUES ($1,$2,$3,$4,'geo-growth')`,
      [workspaceId, tenantId, "关卡减负测试工作区", `gate-${suffix}`],
    );
    // 5 条待放行关卡：3 条低风险 + 1 条 L4 + 1 条高危
    const rows: Array<[string, string, boolean, number]> = [
      [`apr-low-1-${suffix}`, "l2_captain", false, 30],
      [`apr-low-2-${suffix}`, "l2_captain", false, 10],
      [`apr-low-3-${suffix}`, "l3_fleet", false, 4],
      [`apr-l4-${suffix}`, "l4_chairman", true, 50],
      [`apr-risk-${suffix}`, "l2_captain", true, 20],
    ];
    for (const [id, tier, highRisk, ageHours] of rows) {
      await owner.query(
        `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, tier, created_at, snapshot)
         VALUES ($1,$2,$3,$4,'inapp','pending',$5, now() - ($6 || ' hours')::interval, $7)`,
        [id, tenantId, workspaceId, `E-${id}`, tier, String(ageHours),
          JSON.stringify({ title: `关卡 ${id}`, high_risk: highRisk, action: "publish.execute" })],
      );
    }
  });

  afterAll(async () => {
    await owner.query(`DELETE FROM approvals WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM biz_events WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM workspaces WHERE id=$1`, [workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM tenants WHERE id=$1`, [tenantId]).catch(() => undefined);
    await owner.end();
  });

  it("批量放行：低风险放行、L4/高危留待 pending；整批写汇总事件", async () => {
    const result = await releaseGatesBatch(workspaceId, actor, { quota: 7, sampleRate: 0, seed: 7 });
    expect(result.released.sort()).toEqual([`apr-low-1-${suffix}`, `apr-low-2-${suffix}`, `apr-low-3-${suffix}`].sort());
    expect(result.plan.hold.map((c) => c.approvalId).sort()).toEqual([`apr-l4-${suffix}`, `apr-risk-${suffix}`].sort());
    expect(result.eventId).toMatch(/^E-/);

    const statuses = await owner.query<{ approval_id: string; status: string }>(
      `SELECT approval_id, status FROM approvals WHERE workspace_id=$1 ORDER BY approval_id`,
      [workspaceId],
    );
    const byId = Object.fromEntries(statuses.rows.map((r) => [r.approval_id, r.status]));
    expect(byId[`apr-low-1-${suffix}`]).toBe("approved");
    expect(byId[`apr-l4-${suffix}`]).toBe("pending");
    expect(byId[`apr-risk-${suffix}`]).toBe("pending");

    const summary = await owner.query<{ after: Record<string, unknown> }>(
      `SELECT payload->'decision'->'after' AS after FROM biz_events
        WHERE workspace_id=$1 AND payload->'decision'->>'action'='gate.batch_release'`,
      [workspaceId],
    );
    expect(summary.rows[0]?.after).toMatchObject({ releasedCount: 3, seed: 7 });
    expect((summary.rows[0]?.after as { hold?: string[] }).hold?.length).toBe(2);
    // 手势事件在账本（走 review-console 的既有链路，不是旁路改表）
    const gestures = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM biz_events
        WHERE workspace_id=$1 AND payload->'decision'->>'action'='approval.gesture'`,
      [workspaceId],
    );
    expect(Number(gestures.rows[0]!.n)).toBe(3);
  });

  it("H1 仪表：今日裁决 3 件、排队 2 件、超龄 1 件 → over（有超龄）", async () => {
    const metrics = await gateLoadMetrics(workspaceId, 7);
    expect(metrics.decidedToday).toBe(3);
    expect(metrics.pending).toBe(2);
    expect(metrics.pendingByTier).toMatchObject({ l4_chairman: 1, l2_captain: 1 });
    expect(metrics.overdue24h).toBe(1); // apr-l4 已等 50 小时
    expect(metrics.level).toBe("over");
    expect(metrics.summary).toContain("超 24h 1 件");
    expect(metrics.avgDecisionSeconds).not.toBeNull();
  });

  it("配额用尽后再次批量：全部转 hold（不静默放行）", async () => {
    const result = await releaseGatesBatch(workspaceId, actor, { quota: 3, sampleRate: 0, seed: 7 });
    expect(result.released).toEqual([]);
    expect(result.plan.rationale.join("；")).toContain("余 0");
    expect(result.plan.hold.length).toBe(2);
  });
});
