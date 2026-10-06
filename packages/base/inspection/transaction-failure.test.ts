/** Exercise the public inspection operations against transaction failures. */
import type pg from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchFromAnomaly } from "./dispatch.js";
import { assertReadonlyPreset, listOpenAnomalyKeys, loadSnapshot } from "./scan.js";
import { inspectionStatusBar } from "./status.js";

const gateway = vi.hoisted(() => ({ append: vi.fn(), appendOnClient: vi.fn() }));
vi.mock("../workdata/gateway.js", () => ({
  gatewayAppend: gateway.append, gatewayAppendOnClient: gateway.appendOnClient,
}));
beforeEach(() => {
  gateway.append.mockReset(); gateway.appendOnClient.mockReset();
  gateway.appendOnClient.mockResolvedValue({ eventId: "E-901" });
});
const scope = { tenantId: "test-tenant", workspaceId: "test-workspace" };

function failingPool(options: { commit?: boolean; select?: boolean; rollback?: boolean } = {}) {
  const sqls: string[] = [];
  const release = vi.fn();
  const client = {
    release,
    query: vi.fn(async (sql: string) => {
      sqls.push(sql);
      if (sql === "COMMIT" && options.commit) throw new Error("injected commit failure");
      if (sql === "ROLLBACK" && options.rollback) throw new Error("injected rollback failure");
      if (sql.includes("SELECT archive") && options.select) throw new Error("injected select failure");
      if (sql.includes("'inspect.anomaly'") && !sql.includes("created_at")) {
        return { rows: [{ event_id: "E-900", payload: { decision: { after: { summary: "异常", severity: "high" } }, object: { type: "test", id: "own" } } }] };
      }
      if (sql.includes("AS n")) return { rows: [{ n: 901 }] };
      if (sql.includes("SELECT readonly")) return { rows: [{ readonly: true, meta: { tools: [] } }] };
      if (sql.includes("SELECT archive")) return { rows: [{ archive: { inspection: { test: true } } }] };
      return { rows: [], rowCount: 1 };
    }),
  };
  return { pool: { connect: async () => client } as unknown as pg.Pool, client, sqls, release };
}

describe("巡检事务失败：成功必须在真实 COMMIT 之后，坏连接不回池", () => {
  it("派单不能把 COMMIT 失败返回成成功", async () => {
    const fixture = failingPool({ commit: true });
    await expect(dispatchFromAnomaly(fixture.pool, fixture.pool, scope,
      { anomalyEventId: "E-900", presetKey: "test-agent", by: "MEM-001" })).rejects.toThrow("injected commit failure");
    expect(fixture.sqls).toContain("ROLLBACK");
  });
  for (const [name, operation] of [
    ["只读岗位前检", (pool: pg.Pool) => assertReadonlyPreset(pool, scope)],
    ["快照读取", (pool: pg.Pool) => loadSnapshot(pool, scope)],
    ["异常键查询", (pool: pg.Pool) => listOpenAnomalyKeys(pool, scope, new Date())],
    ["状态条投影", (pool: pg.Pool) => inspectionStatusBar(pool, scope)],
  ] as const) {
    it(`${name}不吞 COMMIT 失败`, async () => {
      const fixture = failingPool({ commit: true });
      await expect(operation(fixture.pool)).rejects.toThrow("injected commit failure");
      expect(fixture.sqls).toContain("ROLLBACK");
      expect(fixture.release).toHaveBeenCalledTimes(1);
    });
  }
  it("查询失败会回滚，且失败之后不会再发 COMMIT", async () => {
    const fixture = failingPool({ select: true });
    await expect(loadSnapshot(fixture.pool, scope)).rejects.toThrow("injected select failure");
    expect(fixture.sqls).toContain("ROLLBACK");
    expect(fixture.sqls).not.toContain("COMMIT");
    expect(fixture.release).toHaveBeenCalledTimes(1);
  });
  it("回滚失败同时保留原错误并丢弃坏连接", async () => {
    const fixture = failingPool({ select: true, rollback: true });
    const failure = await loadSnapshot(fixture.pool, scope).catch(error => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors.map((error: Error) => error.message)).toEqual(["injected select failure", "injected rollback failure"]);
    expect(fixture.release).toHaveBeenCalledWith(true);
    expect(fixture.sqls).not.toContain("COMMIT");
  });
  it("事务内读取同时绑定 tenant 和 workspace", async () => {
    const fixture = failingPool();
    expect(await loadSnapshot(fixture.pool, scope)).toEqual({ test: true });
    expect(fixture.sqls.some(sql => sql.includes("app.tenant_id"))).toBe(true);
    expect(fixture.sqls.some(sql => sql.includes("app.workspace_id"))).toBe(true);
    expect(fixture.sqls.at(-1)).toBe("COMMIT");
  });
});
