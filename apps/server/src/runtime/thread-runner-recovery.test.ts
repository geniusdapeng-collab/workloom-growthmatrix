import { afterEach, describe, expect, it, vi } from "vitest";
import { industryOfWorkspace, loadGoalArchive } from "./thread-runner.js";

const fixture = vi.hoisted(() => ({ pool: {} as object }));
vi.mock("@workloom/db", () => ({ getAppPool: () => fixture.pool, getGatewayPool: () => fixture.pool }));

function connectionPool(failRollback: boolean) {
  let aborted = false;
  const statements: string[] = [];
  const releases: boolean[] = [];
  const connection = {
    async query(text: string) {
      const sql = text.replace(/\s+/gu, " ").trim(); statements.push(sql);
      if (sql === "ROLLBACK") {
        if (failRollback) throw new Error("controlled connection lost");
        aborted = false; return { rows: [] };
      }
      if (aborted) throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
      if (sql.startsWith("SELECT industry") || sql.startsWith("SELECT archive")) {
        aborted = true; throw new Error("controlled lookup failure");
      }
      return { rows: [] };
    },
    release(destroy = false) { releases.push(destroy); if (destroy) aborted = false; },
  };
  fixture.pool = { connect: async () => connection };
  return { connection, statements, releases };
}

afterEach(() => vi.restoreAllMocks());
describe("派单行业及目标档案回退时的事务恢复", () => {
  for (const kind of ["industry", "goal"] as const) {
    for (const failRollback of [false, true]) {
      it(`${kind} 读取失败时${failRollback ? "销毁无法回滚的连接" : "先回滚再归还连接"}`, async () => {
        const { connection, statements, releases } = connectionPool(failRollback);
        const scope = { tenantId: "thread-recovery-tenant", workspaceId: `thread-${kind}-${String(failRollback)}` };
        const result = kind === "industry" ? await industryOfWorkspace(scope) : await loadGoalArchive(scope, "example");
        expect(result).toBe(kind === "industry" ? null : undefined);
        expect(statements.at(-1)).toBe("ROLLBACK");
        expect(releases).toEqual([failRollback]);
        await expect(connection.query("SELECT 1")).resolves.toEqual({ rows: [] });
      });
    }
  }
});
