/**
 * watchdog —— 三类看门狗纯函数（B-35）
 *
 * ① 触发器漏触发：按 cron 近似周期（分钟）与最近触发时间对比；
 * ② 连接器陈旧：未配置/错误直接告警；已配置但长时间无成功回执 → 陈旧；
 * ③ 审批 SLA：pending 审批按 tier 的时限判定（1× 警告 / 2× 严重）。
 *
 * 纪律：只产出发现与建议，不自动处置；DB 读取与事件落库由服务层完成。
 */

export type WatchSeverity = "warn" | "critical";

export interface WatchFinding {
  kind: "trigger" | "connector" | "approval";
  subject: string;
  severity: WatchSeverity;
  detail: string;
  suggestion: string;
}

export interface TriggerHeartbeat {
  triggerId: string;
  name: string;
  schedule: string;
  lastFiredAt: string | null;
  enabled: boolean;
}

export interface ConnectorHeartbeat {
  id: string;
  name: string;
  state: "ready" | "unconfigured" | "error";
  lastSuccessAt: string | null;
}

export interface ApprovalAge {
  approvalId: string;
  tier: string;
  createdAt: string;
  status: string;
}

/** cron（5 段）→ 近似周期分钟；无法解析返回 null（跳过，不误报）。 */
export function cronIntervalMinutes(expr: string): number | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonth, , dayOfWeek] = parts as [string, string, string, string, string];
  const stepOf = (field: string): number | null => {
    const m = /^\*\/(\d+)$/.exec(field);
    return m ? Number(m[1]) : null;
  };
  const minuteStep = stepOf(minute);
  if (minuteStep && hour === "*") return minuteStep;
  const hourStep = stepOf(hour);
  if (hourStep) return hourStep * 60;
  if (dayOfWeek !== "*") return 7 * 24 * 60;
  if (dayOfMonth !== "*") return 30 * 24 * 60;
  if (/^\d+$/.test(hour)) return 24 * 60;
  return 24 * 60;
}

const minutesSince = (iso: string | null, now: Date): number | null => {
  if (!iso) return null;
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return null;
  return Math.round((now.getTime() - at) / 60_000);
};

export function checkTriggers(rows: TriggerHeartbeat[], now = new Date()): WatchFinding[] {
  const findings: WatchFinding[] = [];
  for (const row of rows) {
    if (!row.enabled) continue;
    const interval = cronIntervalMinutes(row.schedule);
    if (!interval) continue;
    const age = minutesSince(row.lastFiredAt, now);
    if (age === null) {
      findings.push({
        kind: "trigger", subject: row.triggerId, severity: "warn",
        detail: `触发器「${row.name}」从未触发（周期约 ${interval} 分钟）`,
        suggestion: "检查触发器引擎游标与工作区时区；必要时手动触发一次并核对 trigger_fires",
      });
      continue;
    }
    if (age > interval * 2) {
      findings.push({
        kind: "trigger", subject: row.triggerId, severity: "critical",
        detail: `触发器「${row.name}」已 ${age} 分钟未触发（周期约 ${interval} 分钟，超 2×）`,
        suggestion: "检查触发器引擎/队列与租约；恢复后补跑并核对漏触发窗口",
      });
    } else if (age > interval * 1.5) {
      findings.push({
        kind: "trigger", subject: row.triggerId, severity: "warn",
        detail: `触发器「${row.name}」已 ${age} 分钟未触发（周期约 ${interval} 分钟，超 1.5×）`,
        suggestion: "观察下一周期是否恢复；连续两轮异常升级为严重",
      });
    }
  }
  return findings;
}

export function checkConnectors(rows: ConnectorHeartbeat[], now = new Date(), maxAgeMinutes = 120): WatchFinding[] {
  const findings: WatchFinding[] = [];
  for (const row of rows) {
    if (row.state !== "ready") {
      findings.push({
        kind: "connector", subject: row.id, severity: row.state === "error" ? "critical" : "warn",
        detail: `连接器「${row.name}」状态 ${row.state}`,
        suggestion: "按 docs/connectors-mock-exit.md 配置/修复；未配置期间相关任务保持 connector-required",
      });
      continue;
    }
    const age = minutesSince(row.lastSuccessAt, now);
    if (age !== null && age > maxAgeMinutes) {
      findings.push({
        kind: "connector", subject: row.id, severity: "warn",
        detail: `连接器「${row.name}」已 ${age} 分钟无成功回执（阈值 ${maxAgeMinutes} 分钟）`,
        suggestion: "检查凭证有效期/对端限流与网络；恢复后补采缺失窗口",
      });
    }
  }
  return findings;
}

export const DEFAULT_APPROVAL_SLA_HOURS: Record<string, number> = {
  l2_captain: 4, l3_fleet: 8, l4_chairman: 12,
};

export function checkApprovals(
  rows: ApprovalAge[], now = new Date(), slaHoursByTier: Record<string, number> = DEFAULT_APPROVAL_SLA_HOURS,
): WatchFinding[] {
  const findings: WatchFinding[] = [];
  for (const row of rows) {
    if (row.status !== "pending") continue;
    const sla = slaHoursByTier[row.tier] ?? 24;
    const ageHours = (minutesSince(row.createdAt, now) ?? 0) / 60;
    if (ageHours > sla * 2) {
      findings.push({
        kind: "approval", subject: row.approvalId, severity: "critical",
        detail: `审批 ${row.approvalId}（${row.tier}）已等待 ${ageHours.toFixed(1)} 小时（SLA ${sla}h，超 2×）`,
        suggestion: "立即升级到对应决策人并核对通知通道；必要时走叫停/回滚",
      });
    } else if (ageHours > sla) {
      findings.push({
        kind: "approval", subject: row.approvalId, severity: "warn",
        detail: `审批 ${row.approvalId}（${row.tier}）已等待 ${ageHours.toFixed(1)} 小时（SLA ${sla}h）`,
        suggestion: "提醒决策人处理；持续超时将进入 2× 严重档",
      });
    }
  }
  return findings;
}

export function summarizeFindings(findings: WatchFinding[]): string {
  if (findings.length === 0) return "看门狗：无异常";
  const critical = findings.filter((f) => f.severity === "critical").length;
  const warn = findings.length - critical;
  const lines = findings.map((f) => `${f.severity === "critical" ? "✗" : "⚠"} [${f.kind}] ${f.detail} → ${f.suggestion}`);
  return `看门狗：${findings.length} 项（严重 ${critical} / 警告 ${warn}）\n${lines.join("\n")}`;
}
