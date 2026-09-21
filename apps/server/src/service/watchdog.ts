/**
 * service · 看门狗报告（B-35）
 *
 * 汇总三类巡检（触发器漏触发 / 连接器陈旧 / 审批 SLA）→ 输出发现 + 写 `watchdog.report` 事件。
 * 只报告不处置；严重项由 captain 队列或人工接管。
 */
import { connectorReadiness } from "@workloom/base/connectors";
import {
  checkApprovals, checkConnectors, checkTriggers, summarizeFindings,
  type ApprovalAge, type ConnectorHeartbeat, type TriggerHeartbeat, type WatchFinding,
} from "@workloom/base/watchdog";
import { appendEventOn, serviceTx, svcQuery } from "./events.js";

export interface WatchdogReport {
  findings: WatchFinding[];
  summary: string;
  counts: { trigger: number; connector: number; approval: number; critical: number; warn: number };
  eventId: string;
}

export async function runWatchdog(workspaceId: string, now = new Date()): Promise<WatchdogReport> {
  const triggerRows = await svcQuery<{ id: string; name: string; schedule: string; enabled: boolean; last_fired: string | null }>(
    workspaceId,
    `SELECT t.id, t.name, t.schedule, t.enabled,
            (SELECT max(f.fire_minute)::text FROM trigger_fires f
              WHERE f.trigger_id=t.id AND f.workspace_id=t.workspace_id) AS last_fired
       FROM triggers t WHERE t.workspace_id=$1`,
    [workspaceId],
  );
  const triggers: TriggerHeartbeat[] = triggerRows.map((row) => ({
    triggerId: row.id, name: row.name, schedule: row.schedule, lastFiredAt: row.last_fired, enabled: row.enabled,
  }));
  const approvalRows = await svcQuery<{ approval_id: string; tier: string; created_at: string; status: string }>(
    workspaceId,
    `SELECT approval_id, tier, created_at::text AS created_at, status
       FROM approvals WHERE workspace_id=$1 AND status='pending'`,
    [workspaceId],
  );
  const approvals: ApprovalAge[] = approvalRows.map((row) => ({
    approvalId: row.approval_id, tier: row.tier, createdAt: row.created_at, status: row.status,
  }));
  const connectors: ConnectorHeartbeat[] = connectorReadiness({ env: process.env }).map((row) => ({
    id: row.id, name: row.name, state: row.state, lastSuccessAt: null,
  }));

  const findings = [
    ...checkTriggers(triggers, now),
    ...checkConnectors(connectors, now),
    ...checkApprovals(approvals, now),
  ];
  const counts = {
    trigger: findings.filter((f) => f.kind === "trigger").length,
    connector: findings.filter((f) => f.kind === "connector").length,
    approval: findings.filter((f) => f.kind === "approval").length,
    critical: findings.filter((f) => f.severity === "critical").length,
    warn: findings.filter((f) => f.severity === "warn").length,
  };
  const summary = summarizeFindings(findings);
  const { eventId } = await serviceTx(workspaceId, async (client, scope) =>
    appendEventOn(client, scope, { id: "watchdog", type: "system" }, {
      objectType: "watchdog", objectId: workspaceId, action: "watchdog.report",
      after: { counts, findings: findings.slice(0, 50), summary },
    }));
  return { findings, summary, counts, eventId };
}

export async function listWatchdogReports(workspaceId: string, limit = 10): Promise<Array<{ at: string; summary: string; counts: WatchdogReport["counts"] }>> {
  const rows = await svcQuery<{ created_at: string; after: Record<string, unknown> }>(
    workspaceId,
    `SELECT created_at::text AS created_at, payload->'decision'->'after' AS after
       FROM biz_events WHERE workspace_id=$1 AND payload->'decision'->>'action'='watchdog.report'
      ORDER BY seq DESC LIMIT $2`,
    [workspaceId, limit],
  );
  return rows.map((row) => ({
    at: row.created_at,
    summary: String(row.after?.summary ?? ""),
    counts: (row.after?.counts ?? { trigger: 0, connector: 0, approval: 0, critical: 0, warn: 0 }) as WatchdogReport["counts"],
  }));
}
