/**
 * B-33 增长日表活库契约：growth_daily 视图可查、五项齐全、与平台采集对齐。
 * 依赖 db:seed（seed-geo 写入 7 天 × 2 账号的 account_growth_daily）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

process.env.DATABASE_APP_URL ??= "postgres://workloom_app:workloom_dev_app@localhost:5432/workloom";
const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_APP_URL);
const WS = "ws-geo";
const TENANT = "tenant-demo";

describe.runIf(RUN_DB)("B-33 增长日表（growth_daily）", () => {
  const app = new pg.Client({ connectionString: process.env.DATABASE_APP_URL });
  beforeAll(async () => {
    await app.connect();
    await app.query("BEGIN");
    await app.query("SELECT set_config('app.workspace_id', $1, true)", [WS]);
    await app.query("SELECT set_config('app.tenant_id', $1, true)", [TENANT]);
  });
  afterAll(async () => {
    await app.query("ROLLBACK").catch(() => undefined);
    await app.end().catch(() => undefined);
  });

  it("近 7 天 × 2 账号齐全，五项字段与 source 标注在列", async () => {
    const rows = await app.query<{
      account_id: string; days: string; fans: string; interactions: string; source: string;
    }>(
      `SELECT account_id, count(DISTINCT day)::text AS days,
              sum(fans_delta)::text AS fans, sum(interactions)::text AS interactions,
              min(source) AS source
         FROM growth_daily
        WHERE workspace_id=$1 AND day >= (CURRENT_DATE - 7)
        GROUP BY account_id ORDER BY account_id`,
      [WS],
    );
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) {
      expect(Number(row.days)).toBe(7);
      expect(Number(row.fans)).not.toBe(0);
      expect(Number(row.interactions)).toBeGreaterThan(0);
      expect(["mock", "live", "simulated"]).toContain(row.source);
    }
  });

  it("视图与平台采集对齐：同一天同一账号有播放量聚合", async () => {
    const r = await app.query<{ aligned: string }>(
      `SELECT count(*)::text AS aligned FROM growth_daily
        WHERE workspace_id=$1 AND plays > 0 AND day >= (CURRENT_DATE - 7)`,
      [WS],
    );
    expect(Number(r.rows[0]!.aligned)).toBeGreaterThanOrEqual(14);
  });
});
