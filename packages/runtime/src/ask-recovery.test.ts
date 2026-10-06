import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAskFactProvider, runAsk } from "./ask.js";

vi.mock("@workloom/base/evolve", () => ({
  loadActivePreferences: async () => [],
  buildPreferenceBlock: () => "",
  preferenceMemoryRefs: () => undefined,
  recordPreferenceUsageInTx: async () => undefined,
}));
vi.mock("@workloom/base/workdata", () => ({
  gatewayAppendOnClient: async () => ({ eventId: "recovery-event" }),
}));

/** A checked-out connection remains aborted until rollback or destruction. */
function poolFixture({ failLookup = true, failRollback = false } = {}) {
  let aborted = false;
  let failed = false;
  let lookups = 0;
  const releases: boolean[] = [];
  const statements: string[] = [];
  const client = {
    async query(text: string) {
      const sql = text.replace(/\s+/gu, " ").trim();
      statements.push(sql);
      if (sql === "ROLLBACK") {
        if (failRollback) throw new Error("connection lost while rolling back");
        aborted = false;
        return { rows: [] };
      }
      if (aborted) throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
      if (sql.startsWith("SELECT industry")) {
        lookups += 1;
        if (failLookup && !failed) {
          failed = true;
          aborted = true;
          throw Object.assign(new Error("industry lookup failed"), { code: "42703" });
        }
        return { rows: [{ industry: null }] };
      }
      return { rows: [] };
    },
    release(destroy = false) {
      releases.push(destroy);
      if (destroy) aborted = false;
    },
  };
  const app = {
    async connect() { return client; },
    async query() { return { rows: [], rowCount: 1 }; },
  } as unknown as pg.Pool;
  registerAskFactProvider("_default", async (connectionPool) => {
    const connection = await connectionPool.connect();
    try {
      await connection.query("SELECT 1");
      return { facts: [{ label: "连接状态", value: "回退取数可用" }], sources: ["controlled-connection"] };
    } finally { connection.release(); }
  });
  return { app, releases, statements, lookups: () => lookups };
}

afterEach(() => vi.restoreAllMocks());

describe("ASK 行业取数失败后的连接池恢复", () => {
  it("行业查询失败先回滚，再用可用连接完成底座回退，失败结果不缓存", async () => {
    const fixture = poolFixture();
    const scope = { tenantId: "ask-recovery-tenant", workspaceId: "ask-recovery-query" };
    const result = await runAsk(fixture.app, fixture.app, scope, { threadId: "first", goal: "查看运行状态", presetKey: "ceo" });
    expect(result.answer).toContain("回退取数可用");
    const lookup = fixture.statements.findIndex(sql => sql.startsWith("SELECT industry"));
    expect(fixture.statements[lookup + 1]).toBe("ROLLBACK");
    expect(fixture.releases[0]).toBe(false);
    await runAsk(fixture.app, fixture.app, scope, { threadId: "retry", goal: "再次查看", presetKey: "ceo" });
    expect(fixture.lookups()).toBe(2);
  });

  it("回滚也失败时销毁连接，不能把中毒连接交还池中", async () => {
    const fixture = poolFixture({ failRollback: true });
    const result = await runAsk(fixture.app, fixture.app,
      { tenantId: "ask-recovery-tenant", workspaceId: "ask-recovery-discard" },
      { threadId: "discard", goal: "查看运行状态", presetKey: "ceo" });
    expect(result.status).toBe("completed");
    expect(fixture.releases[0]).toBe(true);
  });

  it("正常行业读取仍提交并缓存结果，不额外回滚或销毁连接", async () => {
    const fixture = poolFixture({ failLookup: false });
    const scope = { tenantId: "ask-recovery-tenant", workspaceId: "ask-recovery-success" };
    for (const threadId of ["one", "two"]) {
      await runAsk(fixture.app, fixture.app, scope, { threadId, goal: "查看运行状态", presetKey: "ceo" });
    }
    expect(fixture.lookups()).toBe(1);
    expect(fixture.statements).not.toContain("ROLLBACK");
    expect(fixture.releases.every(destroy => !destroy)).toBe(true);
  });
});
