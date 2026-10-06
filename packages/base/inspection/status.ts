/**
 * inspection · 巡检状态条投影（F9.4）：首页展示正常项/总数 + 最近巡检时间 + 异常渠道/账号点名
 * 纪律：纯日志投影（H-7 同源——不建额外表/报表管道），数据源=当日 inspect.* 事件流
 * 「需要关注」区聚合（F9.2）：最多 5 条，按严重度排序
 */
import type pg from "pg";
import type { Severity } from "./checks.js";
import { withInspectionTransaction } from "./transaction.js";

interface Scope { tenantId: string; workspaceId: string }

/** 首页「需要关注」区上限（F9.2 原文：最多 5 条，按严重度排序） */
export const ATTENTION_MAX_ITEMS = 5;

export interface StatusBar {
  /** 最近一次巡检时间（无则 null） */
  lastRunAt: string | null;
  totalChecks: number;
  okCount: number;
  /** 未解决异常（点名 objectId），按严重度排序，最多 ATTENTION_MAX_ITEMS 条 */
  attention: Array<{ eventId: string; severity: Severity; summary: string; objectType: string; objectId?: string }>;
  /** 最近一次巡检是否失败（假平安防线，US9.3） */
  lastRunFailed: boolean;
}

const RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

export async function inspectionStatusBar(
  app: pg.Pool,
  scope: Scope,
  day: Date = new Date(),
): Promise<StatusBar> {
  return withInspectionTransaction(app, scope, async client => {
    const dayStart = new Date(day); dayStart.setHours(0, 0, 0, 0);

    const lastRun = await client.query<{
      created_at: Date;
      payload: { decision: { action: string; after?: { totalChecks?: number; okCount?: number } } };
    }>(
      `SELECT created_at, payload FROM biz_events
       WHERE workspace_id=$1 AND created_at >= $2 AND tenant_id=$3
         AND payload->'decision'->>'action' IN ('inspect.run.completed','inspect.run.failed')
       ORDER BY seq DESC LIMIT 1`,
      [scope.workspaceId, dayStart.toISOString(), scope.tenantId],
    );
    const last = lastRun.rows[0];
    const lastRunFailed = last?.payload.decision.action === "inspect.run.failed";

    const anomalies = await client.query<{
      event_id: string; created_at: Date;
      payload: { decision: { after?: { severity?: Severity; summary?: string } }; object: { type: string; id?: string } };
    }>(
      `SELECT event_id, created_at, payload FROM biz_events
       WHERE workspace_id=$1 AND created_at >= $2 AND tenant_id=$3 AND payload->'decision'->>'action' = 'inspect.anomaly'
       ORDER BY seq ASC`,
      [scope.workspaceId, dayStart.toISOString(), scope.tenantId],
    );
    const resolved = await client.query<{ payload: { links?: string[] } }>(
      `SELECT payload FROM biz_events
       WHERE workspace_id=$1 AND created_at >= $2 AND tenant_id=$3 AND payload->'decision'->>'action' IN ('inspect.resolved','inspect.escalated')`,
      [scope.workspaceId, dayStart.toISOString(), scope.tenantId],
    );
    const resolvedIds = new Set(resolved.rows.flatMap((r) => r.payload.links ?? []));

    const open = anomalies.rows
      .filter((a) => !resolvedIds.has(a.event_id))
      .map((a) => ({
        eventId: a.event_id,
        severity: a.payload.decision.after?.severity ?? ("low" as Severity),
        summary: a.payload.decision.after?.summary ?? "",
        objectType: a.payload.object.type,
        objectId: a.payload.object.id,
      }))
      .sort((a, b) => RANK[b.severity] - RANK[a.severity])
      .slice(0, ATTENTION_MAX_ITEMS);

    return {
      lastRunAt: last?.created_at?.toISOString() ?? null,
      totalChecks: last?.payload.decision.after?.totalChecks ?? 0,
      okCount: last?.payload.decision.after?.okCount ?? 0,
      attention: open,
      lastRunFailed,
    };
  });
}
