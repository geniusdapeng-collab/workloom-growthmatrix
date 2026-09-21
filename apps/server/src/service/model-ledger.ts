/**
 * service · 模型配置版本台账（B-30）
 *
 * 记录「谁在何时把哪个场景换成哪档/哪个模型、怎么回滚」：写 `model.config.changed` 五元事件，
 * 台账只增不改；查询直接读事件库（可复跑、可审计）。
 */
import {
  buildRollbackCommand, diffModelConfig,
  type ModelConfigChange, type ModelConfigSnapshot,
} from "@workloom/base/model-router";
import { appendEventOn, serviceTx, svcQuery } from "./events.js";

export interface RecordModelChangeInput {
  by: string;
  prev: ModelConfigSnapshot[];
  next: ModelConfigSnapshot[];
  reason?: string;
}

export async function recordModelConfigChange(
  workspaceId: string, input: RecordModelChangeInput,
): Promise<{ eventId: string; changes: ModelConfigChange[] }> {
  const changes = diffModelConfig(input.prev, input.next);
  if (changes.length === 0) throw new Error("模型配置无变化，不写台账（避免空变更噪音）");
  const result = await serviceTx(workspaceId, async (client, scope) =>
    appendEventOn(client, scope, { id: input.by, type: "human" }, {
      objectType: "model_config", objectId: workspaceId, action: "model.config.changed",
      after: {
        changes,
        rollback: changes.map(buildRollbackCommand),
        ...(input.reason ? { reason: input.reason } : {}),
      },
    }));
  return { eventId: result.eventId, changes };
}

export interface ModelLedgerRow {
  at: string;
  by: string;
  changes: ModelConfigChange[];
  rollback: string[];
  reason?: string;
}

export async function listModelConfigChanges(workspaceId: string, limit = 20): Promise<ModelLedgerRow[]> {
  const rows = await svcQuery<{ created_at: string; who: string; after: Record<string, unknown> }>(
    workspaceId,
    `SELECT created_at::text AS created_at, payload->'who'->>'id' AS who,
            payload->'decision'->'after' AS after
       FROM biz_events
      WHERE workspace_id=$1 AND payload->'decision'->>'action'='model.config.changed'
      ORDER BY seq DESC LIMIT $2`,
    [workspaceId, limit],
  );
  return rows.map((row) => ({
    at: String(row.created_at),
    by: String(row.who ?? "unknown"),
    changes: Array.isArray(row.after?.changes) ? row.after.changes as ModelConfigChange[] : [],
    rollback: Array.isArray(row.after?.rollback) ? row.after.rollback as string[] : [],
    ...(typeof row.after?.reason === "string" ? { reason: row.after.reason } : {}),
  }));
}
