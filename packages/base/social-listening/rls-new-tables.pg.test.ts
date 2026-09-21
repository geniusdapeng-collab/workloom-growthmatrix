/**
 * B-79 新增表/对象 RLS 用例：account_growth_daily 与 growth_daily 视图必须租户隔离。
 * 口径：app 角色未设 GUC → 0 行；设成其他工作区 → 0 行；设成本工作区 → 有行。
 */
import { describe, expect, it } from "vitest";
import pg from "pg";

process.env.DATABASE_APP_URL ??= "postgres://workloom_app:workloom_dev_app@localhost:5432/workloom";
const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_APP_URL);

describe.runIf(RUN_DB)("B-79 新增表 RLS（account_growth_daily / growth_daily）", () => {
  /** 每个用例独立连接：避免同连接上的事务级 GUC 与其它用例相互影响。 */
  const withClient = async <T>(fn: (client: pg.Client) => Promise<T>): Promise<T> => {
    const client = new pg.Client({ connectionString: process.env.DATABASE_APP_URL });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end().catch(() => undefined);
    }
  };

  it("未设 GUC → 0 行（RLS 生效）", async () => {
    await withClient(async (client) => {
      // 防呆：必须以 workloom_app 角色连接（表 owner/superuser 会绕过 RLS，测不出隔离）
      const who = await client.query<{ u: string; guc: string | null }>(
        `SELECT current_user AS u, current_setting('app.workspace_id', true) AS guc`,
      );
      expect(who.rows[0]!.u).toBe("workloom_app");
      expect(who.rows[0]!.guc).toBeNull();
      const r = await client.query(`SELECT count(*)::int AS n FROM account_growth_daily`);
      expect(r.rows[0]!.n).toBe(0);
      const v = await client.query(`SELECT count(*)::int AS n FROM growth_daily`);
      expect(v.rows[0]!.n).toBe(0);
    });
  });

  it("设成其他工作区 → 0 行；设成本工作区 → 有行", async () => {
    await withClient(async (client) => {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', 'ws-yunqi', true)");
      const other = await client.query(`SELECT count(*)::int AS n FROM account_growth_daily WHERE workspace_id='ws-geo'`);
      expect(other.rows[0]!.n).toBe(0);
      await client.query("ROLLBACK");

      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', 'ws-geo', true)");
      const own = await client.query(`SELECT count(*)::int AS n FROM account_growth_daily WHERE workspace_id='ws-geo'`);
      expect(own.rows[0]!.n).toBeGreaterThan(0);
      const view = await client.query(`SELECT count(*)::int AS n FROM growth_daily WHERE workspace_id='ws-geo'`);
      expect(view.rows[0]!.n).toBeGreaterThan(0);
      await client.query("ROLLBACK");
    });
  });
});
