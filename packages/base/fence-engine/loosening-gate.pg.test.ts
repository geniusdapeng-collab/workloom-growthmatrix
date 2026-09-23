/**
 * 围栏放宽的双闸门（2026-09-24 B-74 演练修复）· 活库契约：
 *  - 默认纪律不变：基线规则只可加严，任何放宽一律拒绝；
 *  - 唯一合法通道：变更经 **L4 董事长级** 审批放行（tier=l4_chairman 且已由人裁决）时才允许放宽，
 *    否则即便有 L2 审批、dry-run 已确认也拒绝（防"用低层审批悄悄松绑"）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { activateRuleVersion, confirmDryRun, createDryRun, type RuntimeRule } from "./lifecycle.js";
import { gatewayAppend } from "../workdata/gateway.js";

process.env.DATABASE_URL ??= "postgres://postgres:workloom@localhost:5432/workloom";
process.env.DATABASE_APP_URL ??= "postgres://workloom_app:workloom_dev_app@localhost:5432/workloom";
process.env.DATABASE_GATEWAY_URL ??= "postgres://workloom_gateway:workloom_dev_gateway@localhost:5432/workloom";

const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_APP_URL);
const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const tenantId = `tenant-loosen-${suffix}`;
const workspaceId = `ws-loosen-${suffix}`;
const RULE_ID = "G-LOOSEN1";

describe.runIf(RUN_DB)("围栏放宽需 L4 放行", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL });
  const gateway = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL });
  const baselineRule: RuntimeRule = {
    rule_id: RULE_ID, version: "v1", name: "放宽闸门测试基线", level: "block", is_baseline: true,
    objectTypes: ["content"], actions: ["content.submit"], when: "true",
  };

  beforeAll(async () => {
    await owner.query(`INSERT INTO tenants (id, name, plan) VALUES ($1,$2,'pro')`, [tenantId, "围栏放宽测试租户"]);
    await owner.query(
      `INSERT INTO workspaces (id, tenant_id, name, slug, industry) VALUES ($1,$2,$3,$4,'geo-growth')`,
      [workspaceId, tenantId, "围栏放宽测试工作区", `loosen-${suffix}`],
    );
    await owner.query(
      `INSERT INTO fence_rules (id, rule_id, version, workspace_id, name, level, match_spec, action, is_baseline, status, created_by)
       VALUES ($1,$2,'v1',$3,$4,'block',$5,'{"result":"blocked"}',true,'active','MEM-T01')`,
      [`fr-$RULE_ID-v1-$suffix`, RULE_ID, workspaceId, baselineRule.name,
        JSON.stringify({ object_types: baselineRule.objectTypes, actions: baselineRule.actions, when: baselineRule.when })],
    );
  });

  afterAll(async () => {
    await owner.query(`DELETE FROM fence_rules WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM fence_dry_runs WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM approvals WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM biz_events WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM workspaces WHERE id=$1`, [workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM tenants WHERE id=$1`, [tenantId]).catch(() => undefined);
    await app.end();
    await gateway.end();
    await owner.end();
  });

  /** 走完整治理链：dry-run 确认 + 提案 + 审批行（指定 tier）+ 手势事件 → 返回激活入参 */
  async function prepareActivation(rowId: string, level: "review" | "block", tier: "l2_captain" | "l4_chairman") {
    const candidate: RuntimeRule = { ...baselineRule, version: "v-next", level, name: `放宽候选 ${level}` };
    await owner.query(
      `INSERT INTO fence_rules (id, rule_id, version, workspace_id, name, level, match_spec, action, is_baseline, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'{"result":"review"}',true,'draft','MEM-T01')`,
      [rowId, RULE_ID, `v-draft-${tier}-${level}-${rowId}`, workspaceId, candidate.name, level,
        JSON.stringify({ object_types: candidate.objectTypes, actions: candidate.actions, when: candidate.when })],
    );
    const { dryRunId } = await createDryRun(app, { tenantId, workspaceId }, {
      ruleId: RULE_ID, ruleVersion: `v-draft-${tier}-${level}-${rowId}`, rules: [candidate], defaultLevel: "review", createdBy: "MEM-T01",
    });
    await confirmDryRun(app, { tenantId, workspaceId }, dryRunId);
    const approvalId = `apr-loosen-${tier}-${level}-${suffix}`.slice(0, 60);
    /**
     * 事件一律经安全网关写入（2026-09-24 修复）：此前用裸 INSERT 造提案/手势事件，
     * 假 prev_hash/hash 会污染事件链（verify-chain 实测 4 段 16 处异常）。
     * 网关会算真哈希链、脱敏并做权限校验——测试夹具也必须走真实写入路径。
     */
    const proposal = await writeEvent(`fence.rule.propose`, rowId, {
      ruleId: RULE_ID, dryRunId,
    });
    await owner.query(
      `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, tier, snapshot, decided_by, decided_at)
       VALUES ($1,$2,$3,$4,'inapp','approved',$5,$6,'MEM-T01',now())`,
      [approvalId, tenantId, workspaceId, proposal, tier,
        JSON.stringify({ action: "fence.rule.propose", high_risk: tier === "l4_chairman" })],
    );
    const gestureId = await writeEvent("approval.gesture", rowId, { approvalId, gesture: "approve" });
    return { ruleRowId: rowId, dryRunId, approvalEventId: gestureId };
  }

  /** 经网关写一条事件（真哈希链 + 脱敏 + 权限段），返回 eventId */
  async function writeEvent(action: string, objectId: string, after: Record<string, unknown>): Promise<string> {
    const r = await gatewayAppend(gateway, { tenantId, workspaceId, actor: { id: "MEM-T01", type: "human" } }, {
      who: { type: "human", id: "MEM-T01" },
      context: { tenant_id: tenantId, workspace_id: workspaceId, time: new Date().toISOString(), channel: "inapp" },
      object: { type: "fence_rule", id: objectId },
      decision: { action, after, basis: ["围栏放宽闸门测试夹具"] },
      rule_impact: [],
    } as never);
    return r.eventId;
  }

  it("L2 审批放行放宽 → 拒绝（只紧不松的默认纪律不变）", async () => {
    const input = await prepareActivation(`fr-${RULE_ID}-vnext-l2-${suffix}`, "review", "l2_captain");
    await expect(activateRuleVersion(app, { tenantId, workspaceId }, input))
      .rejects.toThrow(/只可加严|放宽需 L4/);
    const active = await owner.query<{ level: string }>(
      `SELECT level FROM fence_rules WHERE workspace_id=$1 AND rule_id=$2 AND status='active'`,
      [workspaceId, RULE_ID]);
    expect(active.rows[0]?.level).toBe("block"); // 未被放宽
  });

  it("L4 董事长级放行 → 允许放宽（回滚通道），生效版本身份随之推进", async () => {
    const input = await prepareActivation(`fr-${RULE_ID}-vnext-l4-${suffix}`, "review", "l4_chairman");
    const result = await activateRuleVersion(app, { tenantId, workspaceId }, input);
    expect(result.version).toMatch(/^v\d+$/);
    const rows = await owner.query<{ level: string; status: string; version: string }>(
      `SELECT level, status, version FROM fence_rules WHERE workspace_id=$1 AND rule_id=$2 ORDER BY id`,
      [workspaceId, RULE_ID]);
    const active = rows.rows.filter((r) => r.status === "active");
    expect(active).toHaveLength(1);
    expect(active[0]?.level).toBe("review");
    expect(rows.rows.some((r) => r.status === "rolled_back")).toBe(true); // 旧版只增不改留痕
  });
});
