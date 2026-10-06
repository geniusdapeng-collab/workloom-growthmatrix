/** Concurrent scans use unique synthetic scopes and the real app/gateway roles. */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import type { InspectionAdapter } from "./checks.js";
import { runInspectionScan } from "./scan.js";

const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_APP_URL);
describe.runIf(RUN_DB)("巡检扫描原子性与并发去重", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL, max: 12 });
  const gateway = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL, max: 3 });
  afterAll(async () => { await Promise.all([owner.end(), app.end(), gateway.end()]); });
  async function fixture() {
    const id = randomUUID();
    const scope = { tenantId: `t-scan-${id}`, workspaceId: `w-scan-${id}` };
    await owner.query("INSERT INTO tenants(id,name,plan) VALUES($1,'巡检扫描夹具','pro')", [scope.tenantId]);
    await owner.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry) VALUES($1,$2,'巡检扫描夹具',$1,'general')", [scope.workspaceId, scope.tenantId]);
    await owner.query("INSERT INTO agents(id,workspace_id,preset_key,name,version,kind,readonly,status) VALUES($1,$2,'inspection-fixture','只读巡检夹具','1','assistant',true,'ready')", [randomUUID(), scope.workspaceId]);
    const adapter: InspectionAdapter = {
      id: "test.atomic-inspection", presetKey: "inspection-fixture",
      checks: [{ id: "signal", kind: "signal", name: "夹具信号" }],
      probes: { signal: check => [{ checkId: check.id, status: "anomaly", severity: "high",
        summary: "确定性夹具异常", objectType: "scan-test", objectId: id, source: "scan-test" }] },
    };
    const events = async () => (await owner.query(
      "SELECT payload->'decision'->>'action' AS action FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY seq",
      [scope.tenantId, scope.workspaceId])).rows.map(row => row.action as string);
    return { scope, adapter, events };
  }
  it("八路同日同源扫描只写一条异常和一条通知", async () => {
    const f = await fixture();
    const reports = await Promise.all(Array.from({ length: 8 }, () => runInspectionScan(app, gateway, f.scope,
      { adapter: f.adapter, snapshot: {}, retries: 0 })));
    expect(reports.every(report => report.ok)).toBe(true);
    expect(reports.flatMap(report => report.anomalies).filter(item => !item.deduped)).toHaveLength(1);
    const events = await f.events();
    expect(events.filter(action => action === "inspect.anomaly")).toHaveLength(1);
    expect(events.filter(action => action === "inspect.notify")).toHaveLength(1);
    expect(events.filter(action => action === "inspect.run.completed")).toHaveLength(8);
  });
  it("扫描提交拒绝不会留下部分异常/通知/完成事件，保留失败事件且能重试", async () => {
    const f = await fixture(); let rejected = false;
    const failCommitPool = { connect: async () => {
      const client = await app.connect(); const query = client.query.bind(client); let appended = false;
      return { release: client.release.bind(client), query: async (sql: string, values?: unknown[]) => {
        if (sql.includes("append_event_insert")) appended = true;
        if (sql === "COMMIT" && appended && !rejected) {
          rejected = true; throw new Error("injected scan commit refusal");
        }
        return query(sql, values);
      } };
    } } as unknown as pg.Pool;
    const failed = await runInspectionScan(failCommitPool, gateway, f.scope,
      { adapter: f.adapter, snapshot: {}, retries: 0 });
    expect(failed).toMatchObject({ ok: false, attempts: 1 });
    expect(rejected).toBe(true);
    expect(await f.events()).toEqual(["inspect.run.failed"]);
    const retried = await runInspectionScan(app, gateway, f.scope, { adapter: f.adapter, snapshot: {}, retries: 0 });
    expect(retried).toMatchObject({ ok: true });
    expect(retried.anomalies.filter(item => !item.deduped)).toHaveLength(1);
    expect(await f.events()).toEqual(["inspect.run.failed", "inspect.anomaly", "inspect.notify", "inspect.run.completed"]);
  });
  it("不同工作区的相同检项和对象互不去重，空数据也不冒充正常", async () => {
    const a = await fixture(); const b = await fixture();
    const input = { adapter: a.adapter, snapshot: {}, retries: 0 };
    const reports = await Promise.all([a, b].map(f => runInspectionScan(app, gateway, f.scope, input)));
    expect(reports.map(report => report.anomalies.filter(item => !item.deduped).length)).toEqual([1, 1]);
    const empty = { ...a.adapter, probes: { signal: () => [] } };
    expect(await runInspectionScan(app, gateway, a.scope, { adapter: empty, snapshot: {}, retries: 0 }))
      .toMatchObject({ ok: true, totalChecks: 0, okCount: 0, anomalies: [], notifyEventIds: [] });
  });
});
