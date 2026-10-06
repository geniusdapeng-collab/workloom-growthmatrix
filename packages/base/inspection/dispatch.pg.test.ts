/** Real app-role transactions; every fixture belongs to a new synthetic scope. */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gatewayAppend } from "../workdata/gateway.js";
import { dispatchFromAnomaly, resolveAnomaly } from "./dispatch.js";
import { assertReadonlyPreset, loadSnapshot } from "./scan.js";
import { inspectionStatusBar } from "./status.js";

const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_APP_URL);
describe.runIf(RUN_DB)("巡检派单与回链：真实事务、八路竞争、租户隔离", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL, max: 12 });
  const gateway = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL, max: 3 });
  const run = randomUUID();
  const scope = { tenantId: `t-inspect-${run}`, workspaceId: `w-inspect-${run}` };
  beforeAll(async () => {
    await owner.query("INSERT INTO tenants(id,name,plan) VALUES($1,'巡检事务夹具','pro')", [scope.tenantId]);
    await owner.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry) VALUES($1,$2,'巡检事务夹具',$1,'general')", [scope.workspaceId, scope.tenantId]);
    await owner.query("INSERT INTO profiles(workspace_id,tenant_id,industry,archive) VALUES($1,$2,'general',$3::jsonb)",
      [scope.workspaceId, scope.tenantId, JSON.stringify({ inspection: { source: run }, dataMode: "simulated" })]);
    await owner.query("INSERT INTO agents(id,workspace_id,preset_key,name,version,kind,readonly,status) VALUES($1,$2,'inspection-fixture','只读巡检夹具','1','assistant',true,'ready')",
      [randomUUID(), scope.workspaceId]);
  });
  afterAll(async () => { await Promise.all([owner.end(), app.end(), gateway.end()]); });
  async function anomaly() {
    return (await gatewayAppend(gateway, { ...scope, actor: { id: "system", type: "system" } }, {
      who: { id: "system", type: "system" },
      context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
      object: { type: "inspection-test", id: randomUUID() },
      decision: { action: "inspect.anomaly", after: { summary: `独立巡检夹具 ${run}`, severity: "high" } }, rule_impact: [],
    })).eventId;
  }
  async function linkedEvents(id: string, actions: string[]) {
    return (await owner.query("SELECT event_id,payload FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 AND payload->'links' @> $3::jsonb AND payload->'decision'->>'action'=ANY($4::text[])",
      [scope.tenantId, scope.workspaceId, JSON.stringify([id]), actions])).rows;
  }
  const dispatch = (id: string) => dispatchFromAnomaly(app, gateway, scope,
    { anomalyEventId: id, presetKey: "inspection-fixture", by: "MEM-001" });

  it("八路同一异常派单只提交一条任务与一条事件", async () => {
    const id = await anomaly();
    const results = await Promise.all(Array.from({ length: 8 }, () => dispatch(id)));
    expect(new Set(results.map(item => item.threadId)).size).toBe(1);
    expect(new Set(results.map(item => item.eventId)).size).toBe(1);
    expect(results.filter(item => !item.deduped)).toHaveLength(1);
    const events = await linkedEvents(id, ["inspect.dispatch"]);
    expect(events).toHaveLength(1);
    const thread = await owner.query("SELECT id FROM threads WHERE tenant_id=$1 AND workspace_id=$2 AND title=$3",
      [scope.tenantId, scope.workspaceId, `【巡检派单】独立巡检夹具 ${run}`]);
    expect(thread.rows.map(item => item.id)).toContain(results[0]!.threadId);
  });
  it("成功与升级并发回链只有一个最终事件，其余返回相同回执", async () => {
    const id = await anomaly(); const job = await dispatch(id);
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => resolveAnomaly(app, gateway, scope,
      { anomalyEventId: id, threadId: job.threadId, ok: index % 2 === 0, by: "MEM-001" })));
    expect(new Set(results.map(item => item.eventId)).size).toBe(1);
    expect(results.filter(item => !item.deduped)).toHaveLength(1);
    expect(await linkedEvents(id, ["inspect.resolved", "inspect.escalated"])).toHaveLength(1);
  });
  it("回链拒绝不存在或未绑定该异常的任务且不追加最终事件", async () => {
    const id = await anomaly(); const otherId = await anomaly(); const other = await dispatch(otherId);
    for (const threadId of ["T-999999999", other.threadId]) {
      await expect(resolveAnomaly(app, gateway, scope, { anomalyEventId: id, threadId, ok: true, by: "MEM-001" }))
        .rejects.toMatchObject({ code: "THREAD_MISMATCH" });
    }
    expect(await linkedEvents(id, ["inspect.resolved", "inspect.escalated"])).toHaveLength(0);
  });
  it("越租户或工作区派单/回链都不可见，原作用域仍能读取和操作", async () => {
    const id = await anomaly(); const job = await dispatch(id);
    for (const outside of [{ ...scope, tenantId: `other-${run}` }, { ...scope, workspaceId: `other-${run}` }]) {
      await expect(dispatchFromAnomaly(app, gateway, outside, { anomalyEventId: id, presetKey: "inspection-fixture", by: "MEM-001" }))
        .rejects.toMatchObject({ code: "ANOMALY_NOT_FOUND" });
      await expect(resolveAnomaly(app, gateway, outside, { anomalyEventId: id, threadId: job.threadId, ok: true, by: "MEM-001" }))
        .rejects.toMatchObject({ code: "ANOMALY_NOT_FOUND" });
    }
    expect((await dispatch(id)).threadId).toBe(job.threadId);
  });
  it("实际 INSERT 后注入 COMMIT 拒绝，任务与事件一并回滚且可安全重试", async () => {
    const id = await anomaly();
    const failCommitPool = { connect: async () => {
      const client = await app.connect(); const query = client.query.bind(client); let inserted = false;
      return { release: client.release.bind(client), query: async (sql: string, values?: unknown[]) => {
        if (sql.includes("INSERT INTO threads")) inserted = true;
        if (sql === "COMMIT" && inserted) throw new Error("injected inspection commit refusal");
        return query(sql, values);
      } };
    } } as unknown as pg.Pool;
    await expect(dispatchFromAnomaly(failCommitPool, gateway, scope, { anomalyEventId: id, presetKey: "inspection-fixture", by: "MEM-001" }))
      .rejects.toThrow("injected inspection commit refusal");
    expect(await linkedEvents(id, ["inspect.dispatch"])).toHaveLength(0);
    expect(await dispatch(id)).toMatchObject({ deduped: false, threadId: expect.stringMatching(/^T-\d+$/) });
    expect(await linkedEvents(id, ["inspect.dispatch"])).toHaveLength(1);
  });
  it("只读前检、快照和状态条拒绝伪造租户，正对照可读取本区资料", async () => {
    await anomaly();
    const outside = { ...scope, tenantId: `outside-${run}` };
    expect(await loadSnapshot(app, scope)).toEqual({ source: run });
    expect(await loadSnapshot(app, outside)).toEqual({});
    await expect(assertReadonlyPreset(app, scope, "inspection-fixture")).resolves.toBeUndefined();
    await expect(assertReadonlyPreset(app, outside, "inspection-fixture")).rejects.toThrow("未注册");
    expect((await inspectionStatusBar(app, scope)).attention.length).toBeGreaterThan(0);
    expect((await inspectionStatusBar(app, outside)).attention).toHaveLength(0);
  });
});
