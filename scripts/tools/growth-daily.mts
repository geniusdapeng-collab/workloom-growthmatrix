#!/usr/bin/env node
/**
 * growth-daily · 增长日表查询（B-33）
 *
 * 用法：tsx --env-file=.env scripts/tools/growth-daily.mts [--workspace ws-geo] [--days 7]
 * 输出：按平台 × 账号的日表与区间汇总（粉丝净增/互动/私域/唤醒/复购/转介 + 播放与实测互动）。
 */
import pg from "pg";

const argOf = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const workspaceId = argOf("--workspace", "ws-geo");
const days = Number(argOf("--days", "7"));
const connectionString = process.env.DATABASE_APP_URL ?? "postgres://workloom_app:workloom_dev_app@localhost:5432/workloom";

const client = new pg.Client({ connectionString });
await client.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
  const rows = await client.query<{
    platform: string; account_id: string; day: string; fans_delta: number; interactions: number;
    private_adds: number; wakeup_conversions: number; repurchase_count: number; referral_count: number;
    source: string; plays: string; measured_interactions: string;
  }>(
    `SELECT platform, account_id, day::text AS day, fans_delta, interactions, private_adds,
            wakeup_conversions, repurchase_count, referral_count, source, plays, measured_interactions
       FROM growth_daily
      WHERE workspace_id=$1 AND day >= (CURRENT_DATE - $2::int)
      ORDER BY platform, account_id, day`,
    [workspaceId, days],
  );
  console.log(`增长日表 · ${workspaceId} · 近 ${days} 天（growth_daily 视图）`);
  for (const row of rows.rows) {
    console.log([
      row.day, row.platform.padEnd(9), row.account_id.padEnd(22),
      `粉丝净增 ${row.fans_delta}`.padEnd(12),
      `互动 ${row.interactions}`.padEnd(12),
      `私域 ${row.private_adds}`.padEnd(10),
      `唤醒 ${row.wakeup_conversions}`.padEnd(9),
      `复购 ${row.repurchase_count}`.padEnd(9),
      `转介 ${row.referral_count}`.padEnd(9),
      `播放 ${row.plays}`.padEnd(12),
      `source=${row.source}`,
    ].join(" · "));
  }
  const byAccount = new Map<string, { fans: number; interactions: number; private: number; wakeup: number; repurchase: number; referral: number }>();
  for (const row of rows.rows) {
    const key = `${row.platform}/${row.account_id}`;
    const acc = byAccount.get(key) ?? { fans: 0, interactions: 0, private: 0, wakeup: 0, repurchase: 0, referral: 0 };
    acc.fans += Number(row.fans_delta);
    acc.interactions += Number(row.interactions);
    acc.private += Number(row.private_adds);
    acc.wakeup += Number(row.wakeup_conversions);
    acc.repurchase += Number(row.repurchase_count);
    acc.referral += Number(row.referral_count);
    byAccount.set(key, acc);
  }
  console.log("\n区间汇总（五项周表口径）：");
  for (const [key, acc] of byAccount) {
    console.log(`${key} → 粉丝净增 ${acc.fans} · 互动 ${acc.interactions} · 私域沉淀 ${acc.private} · 唤醒转化 ${acc.wakeup} · 复购 ${acc.repurchase} · 转介 ${acc.referral}`);
  }
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
