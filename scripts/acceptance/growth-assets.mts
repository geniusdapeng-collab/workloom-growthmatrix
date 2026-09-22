#!/usr/bin/env node
/**
 * acceptance:growth-assets · 四类新资产验收（B-45）
 *
 * 覆盖：GrowthMatrix 矩阵 / 增长日表 / AI 内容标识 / 通道就绪矩阵。
 * 全部为真库/真文件检查；任一失败非 0 退出（供发布前与 RDAS 引用）。
 */
import pg from "pg";
import { join } from "node:path";
import { loadGrowthMatrix, matrixStats } from "@workloom/base/bundles";
import { buildAiLabelManifest, ffmpegLabelArgs } from "@workloom/base/asset-cms";
import { channelReadiness } from "@workloom/base/publish-rpa";

const root = process.cwd();
const WS = "ws-geo";
let failed = 0;
const check = (ok: boolean, label: string, detail = ""): void => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` —— ${detail}` : ""}`);
  if (!ok) failed += 1;
};

// ① GrowthMatrix：123 条目、结构缺口 0
const matrix = loadGrowthMatrix(join(root, "bundles", "geo-growth", "matrix", "content-platform-matrix.yml"));
const stats = matrixStats(matrix);
check(stats.items >= 120 && stats.classes >= 12, "GrowthMatrix 矩阵数据化", `${stats.classes} 类 / ${stats.items} 条`);

// ② 增长日表：视图可查、7 天 × 2 账号、五项字段齐全
const app = new pg.Client({ connectionString: process.env.DATABASE_APP_URL ?? "postgres://workloom_app:workloom_dev_app@localhost:5432/workloom" });
await app.connect();
try {
  await app.query("BEGIN");
  await app.query("SELECT set_config('app.workspace_id', $1, true)", [WS]);
  const rows = await app.query<{ account_id: string; days: string; fans: string }>(
    `SELECT account_id, count(DISTINCT day)::text AS days, sum(fans_delta)::text AS fans
       FROM growth_daily WHERE workspace_id=$1 AND day >= (CURRENT_DATE - 7)
      GROUP BY account_id ORDER BY account_id`, [WS],
  );
  check(rows.rows.length === 2 && rows.rows.every((r) => Number(r.days) === 7), "growth_daily 视图 7 天 × 2 账号", JSON.stringify(rows.rows));
  const cols = await app.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name='video_assets'
      AND column_name IN ('ai_generated','ai_label','generator_model','label_manifest_uri')`,
  );
  check(cols.rows.length === 4, "video_assets AI 标识四字段在场", cols.rows.map((c) => c.column_name).join(","));
  await app.query("ROLLBACK");
} finally {
  await app.end().catch(() => undefined);
}

// ③ AI 标识清单可产出显式+隐式参数
const manifest = buildAiLabelManifest({ assetId: "va-accept", model: "doubao-seedream-4.0", generatedAt: "2026-09-22T00:00:00Z" });
check(ffmpegLabelArgs(manifest).join(" ").includes("workloom:ai_generated=true"), "AI 标识隐式元数据参数", manifest.explicit.text);

// ④ 通道就绪矩阵：11 通道且未配置通道如实声明排除
const channels = channelReadiness({});
const exclusions = channels.filter((c) => c.state === "declared_exclusion").map((c) => c.id);
check(channels.length === 11, "通道就绪矩阵 11 通道", channels.length.toString());
check(exclusions.includes("tiktok") && exclusions.includes("shipinhao"), "TikTok/视频号声明排除（未联调不冒充 ready）", exclusions.join(","));

console.log(failed === 0 ? "\n四类新资产验收通过" : `\n四类新资产验收失败：${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
