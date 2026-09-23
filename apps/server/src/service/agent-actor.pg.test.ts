/**
 * B-38 agent actor 写路径 · 活库契约：
 *  - 名册事实回库刷新（fence_bindings / readonly / meta.high_risk / version）；
 *  - 不存在 / 停产 / 只读 / 工作区不可用 逐类拒绝（不降级成 human）；
 *  - system 通道只接受白名单组件；
 *  - 以 agent actor 写契约事件时 who.type=agent 且 who.version 齐备（缺 version 直接拒绝）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { AgentActorError, resolveAgentActor } from "./agent-actor.js";
import { appendEventOn, serviceTx } from "./events.js";

process.env.DATABASE_URL ??= "postgres://postgres:workloom@localhost:5432/workloom";
process.env.DATABASE_APP_URL ??= "postgres://workloom_app:workloom_dev_app@localhost:5432/workloom";

const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_APP_URL);
const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const tenantId = `tenant-agentch-${suffix}`;
const workspaceId = `ws-agentch-${suffix}`;

describe.runIf(RUN_DB)("B-38 agent actor 写路径", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  beforeAll(async () => {
    await owner.query(`INSERT INTO tenants (id, name, plan) VALUES ($1,$2,'pro')`, [tenantId, "agent 通道测试租户"]);
    await owner.query(
      `INSERT INTO workspaces (id, tenant_id, name, slug, industry) VALUES ($1,$2,$3,$4,'general')`,
      [workspaceId, tenantId, "agent 通道测试工作区", `agentch-${suffix}`],
    );
    await owner.query(
      `INSERT INTO agents (id, workspace_id, preset_key, name, version, kind, readonly, fence_bindings, meta)
       VALUES ($1,$2,'growth-lead','增长负责人','v9','ops',false,'["G-GROW1","G12"]','{"high_risk":true}'),
              ($3,$2,'retired-writer','停产岗位','v1','ops',false,'["G12"]','{}'),
              ($4,$2,'readonly-watcher','只读观察岗','v2','ops',true,'["G12"]','{}')`,
      [`ag-${suffix}-a`, workspaceId, `ag-${suffix}-b`, `ag-${suffix}-c`],
    );
  });

  afterAll(async () => {
    await owner.query(`DELETE FROM biz_events WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM agents WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM workspaces WHERE id=$1`, [workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM tenants WHERE id=$1`, [tenantId]).catch(() => undefined);
    await owner.end();
  });

  it("ready 岗位：名册事实齐备（fence_bindings/version/high_risk 回库刷新）", async () => {
    const resolved = await resolveAgentActor({ principal: { kind: "agent", presetKey: "growth-lead" }, workspaceId }, { write: true });
    expect(resolved.actor).toMatchObject({ id: "growth-lead", type: "agent", version: "v9", readonly: false, highRisk: true });
    expect(resolved.actor.fenceBindings).toEqual(["G-GROW1", "G12"]);
    expect(resolved.tenantId).toBe(tenantId);
  });

  it("不存在 / 停产 / 只读 / 工作区不可用 → 逐类拒绝", async () => {
    await expect(resolveAgentActor({ principal: { kind: "agent", presetKey: "ghost" }, workspaceId }, { write: true }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await owner.query(`UPDATE agents SET status='disabled' WHERE preset_key='retired-writer' AND workspace_id=$1`, [workspaceId]);
    await expect(resolveAgentActor({ principal: { kind: "agent", presetKey: "retired-writer" }, workspaceId }, { write: true }))
      .rejects.toMatchObject({ code: "DISABLED" });
    await expect(resolveAgentActor({ principal: { kind: "agent", presetKey: "readonly-watcher" }, workspaceId }, { write: true }))
      .rejects.toMatchObject({ code: "READONLY" });
    await expect(resolveAgentActor({ principal: { kind: "agent", presetKey: "growth-lead" }, workspaceId: "ws-not-exist" }, { write: true }))
      .rejects.toBeInstanceOf(AgentActorError);
  });

  it("system 通道：白名单组件放行，非白名单拒绝", async () => {
    const ok = await resolveAgentActor({ principal: { kind: "system", systemId: "captain" }, workspaceId }, { write: true });
    expect(ok.actor).toMatchObject({ id: "captain", type: "system" });
    await expect(resolveAgentActor({ principal: { kind: "system", systemId: "fake-system" }, workspaceId }, { write: true }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("以 agent actor 写事件：who.type=agent 且 who.version 齐备；缺 version 拒绝", async () => {
    const resolved = await resolveAgentActor({ principal: { kind: "agent", presetKey: "growth-lead" }, workspaceId }, { write: true });
    const objectId = `probe-${suffix}`;
    await serviceTx(workspaceId, async (client, scope) => {
      await appendEventOn(client, scope, resolved.actor, {
        objectType: "task_contract", objectId, action: "contract.create", after: { status: "draft" },
      });
    });
    const rows = await owner.query<{ who_type: string; who_id: string; who_version: string | null }>(
      `SELECT payload->'who'->>'type' AS who_type, payload->'who'->>'id' AS who_id, payload->'who'->>'version' AS who_version
         FROM biz_events WHERE workspace_id=$1 AND payload->'object'->>'id'=$2`,
      [workspaceId, objectId],
    );
    expect(rows.rows[0]).toMatchObject({ who_type: "agent", who_id: "growth-lead", who_version: "v9" });

    await expect(serviceTx(workspaceId, async (client, scope) => {
      await appendEventOn(client, scope, { id: "growth-lead", type: "agent", fenceBindings: ["G12"] }, {
        objectType: "task_contract", objectId: `${objectId}-nover`, action: "contract.create",
      });
    })).rejects.toThrow(/version/);
  });
});
