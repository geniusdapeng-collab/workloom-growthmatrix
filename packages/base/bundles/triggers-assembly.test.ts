/**
 * B-02 声明式触发器装配（DB 集成，RUN_DB_TESTS=1）
 *
 * 覆盖：14 条声明幂等装载、工作区后缀 id、客户自建不覆盖、退出声明仅禁用。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import pg from "pg";
import { provisionComposedWorkforce } from "./assembly.js";

const RUN_DB = process.env.RUN_DB_TESTS === "1" && !!process.env.DATABASE_URL;

describe.runIf(RUN_DB)("声明式触发器装配（B-02）", async () => {
  const app = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const suffix = randomUUID().slice(0, 8);
  const tenantId = `tn-tg-${suffix}`;
  const workspaceId = `ws-tg-${suffix}`;
  const scope = { tenantId, workspaceId };

  it("装载 14 条声明并幂等；客户自建不覆盖；退出声明仅禁用", async () => {
    await app.query(
      `INSERT INTO tenants (id, name, plan) VALUES ($1,$2,'pro') ON CONFLICT (id) DO NOTHING`,
      [tenantId, `触发器装配测试 ${suffix}`],
    );
    await app.query(
      `INSERT INTO workspaces (id, tenant_id, name, slug, industry, stage)
       VALUES ($1,$2,$3,$4,'geo-growth','managed')`,
      [workspaceId, tenantId, workspaceId, workspaceId],
    );
    try {
      const first = await provisionComposedWorkforce(app, scope, "geo-growth", "MEM-TG");
      expect(first.triggers).toBe(14);
      const rows = await app.query<{ id: string; declared_id: string; source_bundle: string; enabled: boolean }>(
        `SELECT id, declared_id, source_bundle, enabled FROM triggers WHERE workspace_id=$1 ORDER BY id`,
        [workspaceId],
      );
      expect(rows.rows).toHaveLength(14);
      for (const row of rows.rows) {
        expect(row.declared_id).toBeTruthy();
        expect(row.id.endsWith(`-${workspaceId}`)).toBe(true);
        expect(row.source_bundle).toBe("geo-growth");
        expect(row.enabled).toBe(true);
      }

      // 幂等：重复装配不新增、不改变 id
      const before = rows.rows.map((row) => row.id).join(",");
      const second = await provisionComposedWorkforce(app, scope, "geo-growth", "MEM-TG");
      expect(second.triggers).toBe(14);
      const rows2 = await app.query<{ id: string }>(
        `SELECT id FROM triggers WHERE workspace_id=$1 ORDER BY id`, [workspaceId],
      );
      expect(rows2.rows).toHaveLength(14);
      expect(rows2.rows.map((row) => row.id).join(",")).toBe(before);

      // 客户自建（declared_id 命中但 source_bundle 为空）不被装配覆盖
      await app.query(
        `UPDATE triggers SET source_bundle=NULL, name='客户自建触发器'
          WHERE workspace_id=$1 AND declared_id='tg-geo-intel-0700'`,
        [workspaceId],
      );
      const third = await provisionComposedWorkforce(app, scope, "geo-growth", "MEM-TG");
      expect(third.triggersSkippedCustomer).toBe(1);
      const custom = await app.query<{ name: string; enabled: boolean }>(
        `SELECT name, enabled FROM triggers WHERE workspace_id=$1 AND declared_id='tg-geo-intel-0700'`,
        [workspaceId],
      );
      expect(custom.rows[0]!.name).toBe("客户自建触发器");
      expect(custom.rows[0]!.enabled).toBe(true);

      // 退出声明：上一版存在、本版未声明的触发器只禁用不删除
      await app.query(
        `INSERT INTO triggers
           (id, workspace_id, name, kind, schedule, action, enabled, created_by, source_bundle, declared_version, declared_id)
         VALUES ($1,$2,'旧版触发器','cron','0 1 * * *','{}'::jsonb,true,'test','geo-growth','geo-growth@0.9.0','tg-retired-x')`,
        [`tg-retired-x-${workspaceId}`, workspaceId],
      );
      const fourth = await provisionComposedWorkforce(app, scope, "geo-growth", "MEM-TG");
      expect(fourth.triggersRetired).toBe(1);
      const retired = await app.query<{ enabled: boolean }>(
        `SELECT enabled FROM triggers WHERE workspace_id=$1 AND declared_id='tg-retired-x'`,
        [workspaceId],
      );
      expect(retired.rows[0]!.enabled).toBe(false);
    } finally {
      await app.query(`DELETE FROM triggers WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
      await app.query(`DELETE FROM agents WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
      await app.query(`DELETE FROM fence_rules WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
      await app.query(`DELETE FROM workspaces WHERE id=$1`, [workspaceId]).catch(() => undefined);
      await app.query(`DELETE FROM tenants WHERE id=$1`, [tenantId]).catch(() => undefined);
    }
  }, 60000);
});
