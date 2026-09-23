/**
 * B-72 信任账户接入运行 · 活库契约：
 *  ① 降档（批准率跌破下限）→ 对口自治项自动收紧（cap 减半）+ trust.autonomy_tightened 事件；
 *  ② 红线事故 → trust.retake.required + 复考单进关卡队列；
 *  ③ 升档建议 → pending 关卡（人批后升档）+ trust.upgrade_proposed；
 *  ④ 每轮写 trust.reviewed 快照（晨报读它）；dryRun 只算不写。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { latestTrustSnapshot, matchingAutonomyKeys, runTrustReview, tightenDomains } from "./trust-runtime.js";
import { defaultCharter } from "@workloom/base/captain";
import { getGatewayPool } from "@workloom/db";
import { gatewayAppend } from "@workloom/base/workdata";

process.env.DATABASE_URL ??= "postgres://postgres:workloom@localhost:5432/workloom";
process.env.DATABASE_APP_URL ??= "postgres://postgres:workloom_dev_app@localhost:5432/workloom";
process.env.DATABASE_GATEWAY_URL ??= "postgres://workloom_gateway:workloom_dev_gateway@localhost:5432/workloom";

const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_APP_URL);
const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const tenantId = `tenant-trust-${suffix}`;
const workspaceId = `ws-trust-${suffix}`;
const actor = { id: "MEM-T01", type: "human" as const };

describe("B-72 域→自治项对口（纯函数）", () => {
  it("按包含匹配取对口项；无对口项返回空（不误伤其他域）", () => {
    const charter = defaultCharter();
    charter.autonomy = {
      caps: { price_delta_pct: { label: "价格调整上限", limit: 8 }, ads_budget_daily: { label: "日投放预算", limit: 500 } },
      ranges: { publish_frequency: { label: "发布频率", lower: 1, upper: 5, anchor: 3 } },
      lists: {},
    };
    expect(matchingAutonomyKeys("price", charter.autonomy).caps).toEqual(["price_delta_pct"]);
    expect(matchingAutonomyKeys("ads", charter.autonomy).caps).toEqual(["ads_budget_daily"]);
    expect(matchingAutonomyKeys("unknown-domain", charter.autonomy)).toEqual({ caps: [], ranges: [] });
  });

  it("收紧只作用于命中项：cap 减半、range 向 anchor 收窄一半", () => {
    const charter = defaultCharter();
    charter.autonomy = {
      caps: { price_delta_pct: { label: "价格调整上限", limit: 8 }, ads_budget_daily: { label: "日投放预算", limit: 500 } },
      ranges: { publish_frequency: { label: "发布频率", lower: 1, upper: 5, anchor: 3 } },
      lists: {},
    };
    // 同时收紧 price 域（cap）与 publish 域（range）：只动命中项
    const { charter: tightened, tightenedKeys } = tightenDomains(charter, ["price", "publish"]);
    expect(tightened.autonomy.caps.price_delta_pct?.limit).toBe(4);
    expect(tightened.autonomy.caps.ads_budget_daily?.limit).toBe(500); // 未命中不动
    expect(tightened.autonomy.ranges.publish_frequency).toMatchObject({ lower: 2, upper: 4 });
    expect(tightenedKeys).toEqual(["cap:price_delta_pct", "range:publish_frequency"]);
    // 无对口域：不产生任何收紧（不误伤其他域）
    expect(tightenDomains(charter, ["unknown-domain"]).tightenedKeys).toEqual([]);
  });
});

describe.runIf(RUN_DB)("B-72 信任账户接入运行（活库）", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  beforeAll(async () => {
    await owner.query(`INSERT INTO tenants (id, name, plan) VALUES ($1,$2,'pro')`, [tenantId, "信任账户测试租户"]);
    await owner.query(
      `INSERT INTO workspaces (id, tenant_id, name, slug, industry) VALUES ($1,$2,$3,$4,'geo-growth')`,
      [workspaceId, tenantId, "信任账户测试工作区", `trust-${suffix}`],
    );
    // 宪章：给 price 域一个对口自治项（cap 8）
    const charter = defaultCharter();
    charter.mode = "active";
    charter.autonomy.caps.price_delta_pct = { label: "价格调整上限", limit: 8 };
    await owner.query(
      `INSERT INTO profiles (workspace_id, tenant_id, industry, archive, forbidden)
       VALUES ($1,$2,'geo-growth',$3,'[]'::jsonb)`,
      [workspaceId, tenantId, JSON.stringify({ industry: "geo-growth", dataMode: "simulated", charter })],
    );
    // 20 条 price 域裁决：8 批准 / 12 驳回 → 批准率 0.4 跌破下限 → 降档
    for (let i = 0; i < 20; i += 1) {
      const approved = i < 8;
      await owner.query(
        `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, tier, snapshot, decided_by, decided_at, created_at)
         VALUES ($1,$2,$3,$4,'inapp',$5,'l2_captain',$6,'MEM-001', now() - interval '1 day', now() - interval '2 days')`,
        [`apr-trust-price-${i}-${suffix}`, tenantId, workspaceId, `E-trust-${i}-${suffix}`,
          approved ? "approved" : "rejected",
          JSON.stringify({ action: "price.adjust", high_risk: false, title: `价格调整 ${i}` })],
      );
    }
    // 红线事故：price 域熔断事件——经安全网关写入（哈希链/脱敏/幂等全走真实链路，不旁路插表）
    await gatewayAppend(getGatewayPool(), {
      tenantId, workspaceId, actor: { id: "watchdog", type: "system" },
    }, {
      who: { type: "system", id: "watchdog" },
      context: { tenant_id: tenantId, workspace_id: workspaceId, time: new Date().toISOString(), channel: "inapp" },
      object: { type: "circuit_breaker", id: `cb-${suffix}` },
      decision: { action: "breaker.trigger", params: { domain: "price" }, after: { tripped: true }, basis: ["G11 预算/红线熔断"] },
      rule_impact: [],
    } as never);
  });

  afterAll(async () => {
    await owner.query(`DELETE FROM approvals WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM biz_events WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM profiles WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM workspaces WHERE id=$1`, [workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM tenants WHERE id=$1`, [tenantId]).catch(() => undefined);
    await owner.end();
  });

  it("dryRun 只算不写；正式跑：降档收紧自治项 + 补考单 + 快照事件", async () => {
    const dry = await runTrustReview(workspaceId, actor, { dryRun: true });
    expect(dry.reviewed.some((r) => r.domain === "price" && r.level === "down")).toBe(true);
    expect(dry.events).toEqual([]);

    const result = await runTrustReview(workspaceId, actor);
    const price = result.reviewed.find((r) => r.domain === "price");
    expect(price).toMatchObject({ level: "down", retakeRequired: true });
    expect(price?.tightened).toBe(true);
    expect(price?.tightenedKeys).toContain("cap:price_delta_pct");
    expect(result.events.length).toBeGreaterThanOrEqual(3); // tightened + retake + reviewed
    expect(result.gates).toContain(`apr-trust-retake-price`);

    // 宪章里的自治项确实减半（4 = 8/2）
    const profile = await owner.query<{ archive: { charter: { autonomy: { caps: Record<string, { limit: number }> } } } }>(
      `SELECT archive FROM profiles WHERE workspace_id=$1`, [workspaceId],
    );
    expect(profile.rows[0]?.archive.charter.autonomy.caps.price_delta_pct?.limit).toBe(4);

    // 补考单在关卡队列（pending）
    const gate = await owner.query<{ status: string; tier: string; snapshot: Record<string, unknown> }>(
      `SELECT status, tier, snapshot FROM approvals WHERE workspace_id=$1 AND approval_id=$2`,
      [workspaceId, "apr-trust-retake-price"],
    );
    expect(gate.rows[0]).toMatchObject({ status: "pending", tier: "l3_fleet" });
    expect((gate.rows[0]!.snapshot as { retake?: boolean }).retake).toBe(true);

    // 事件齐备 + 快照可读（晨报同口径）
    const actions = await owner.query<{ action: string; n: string }>(
      `SELECT payload->'decision'->>'action' AS action, count(*)::text AS n FROM biz_events
        WHERE workspace_id=$1 AND payload->'decision'->>'action' LIKE 'trust.%' GROUP BY 1`,
      [workspaceId],
    );
    const byAction = Object.fromEntries(actions.rows.map((r) => [r.action, Number(r.n)]));
    expect(byAction["trust.autonomy_tightened"]).toBe(1);
    expect(byAction["trust.retake.required"]).toBe(1);
    expect(byAction["trust.reviewed"]).toBe(1);

    const snapshot = await latestTrustSnapshot(workspaceId);
    expect(snapshot?.domains.some((d) => d.domain === "price" && d.level === "down")).toBe(true);
  });
});
