/**
 * base/captain · 董事会包 + 扩编规划 + 反馈回路（D22，方案 v2.1 §三/§五）
 *
 * 月度董事会包：目标达成 vs 承诺 / 决策质量（命中率·分级·上浮精准度）/ 团队绩效榜 / 宪章修订提案；
 * 编制健康度扫描：业务域覆盖 + 队列积压 → 招聘提案（L4 董事长逐单批，不设上限）；
 * 赞/踩反馈：入组织记忆，成为后续决策的奖励信号。
 */
import type pg from "pg";
import type { CeoScorecard } from "./scorecard.js";
import type { AgentScorecard } from "./hr.js";
import type { Charter } from "./charter.js";
import { evaluateP2Role, loadP2RolesFromAgents, type P2Evaluation } from "../bundles/p2-ops.js";

interface Scope { tenantId: string; workspaceId: string }

/* ================= 月度董事会包 ================= */

export interface BoardPack {
  period: string;
  kpiSummary: string;
  decisionQuality: {
    hitRate: number | null; decisions: number; tierCounts: Record<string, number>;
    escalationPrecision: string; // 上浮精准度叙事
  };
  teamBoard: Array<{ agentId: string; grade: string; outputs: number }>;
  charterProposal: string[];   // 宪章修订提案（授权扩缩建议）
  nextMonthFocus: string;
}

export function composeBoardPack(input: {
  period: string;
  kpi: Record<string, number | string>;
  scorecard: CeoScorecard;
  agents: AgentScorecard[];
  charter: Charter;
  escalationsApproved: number;
  escalationsTotal: number;
}): BoardPack {
  const { scorecard: sc } = input;
  // 上浮精准度：CEO 上浮的请示被批准率高=上浮合理；过低=过于紧张
  const precision = input.escalationsTotal > 0
    ? `上浮 ${input.escalationsTotal} 件被批准 ${input.escalationsApproved} 件（${((input.escalationsApproved / input.escalationsTotal) * 100).toFixed(0)}%）`
    : "本期无上浮请示";
  // 宪章修订提案（数据驱动授权扩缩，D22 §1.3）
  const proposals: string[] = [];
  if (sc.hitRate !== null) {
    if (sc.hitRate > 0.85 && sc.outcomeCounts.hit + sc.outcomeCounts.miss + sc.outcomeCounts.fail >= 5) {
      proposals.push(`决策命中率 ${(sc.hitRate * 100).toFixed(0)}%>85%：建议适度扩大表现稳定的自治边界，请董事长批示`);
    } else if (sc.hitRate < 0.6) {
      proposals.push(`决策命中率 ${(sc.hitRate * 100).toFixed(0)}%<60%：建议收紧自治带一档并复盘失败模式`);
    }
  }
  if (input.charter.circuit_breaker.tightened) {
    proposals.push("本期触发过自治熔断：建议保持收紧档观察一月，或复核下限设置");
  }
  if (proposals.length === 0) proposals.push("本期无宪章修订建议（授权边界运行良好）");
  const coaching = input.agents.filter((a) => a.grade === "辅导").length;
  return {
    period: input.period,
    kpiSummary: Object.entries(input.kpi).map(([k, v]) => `${k} ${v}`).join("；") || "—",
    decisionQuality: {
      hitRate: sc.hitRate,
      decisions: sc.decisions,
      tierCounts: sc.tierCounts,
      escalationPrecision: precision,
    },
    teamBoard: input.agents.map((a) => ({ agentId: a.agentId, grade: a.grade, outputs: a.outputs })),
    charterProposal: proposals,
    nextMonthFocus: coaching > 0
      ? `${coaching} 名员工辅导中，重点跟踪改善；` + "目标缺口域优先补救"
      : "团队全员达标，聚焦目标冲刺与打法固化",
  };
}

/* ================= 编制健康度与招聘提案 ================= */

export interface OrgHealth {
  agentCount: number;
  backlog: number;             // L2 积压
  uncovered: string[];         // 无 coverage 的业务域（有事件但无 owner agent）
  overworked: Array<{ agentId: string; outputs: number }>; // 产出过载（>均值 2 倍）
}

interface CoverageDeclaration {
  eventPrefix: string;
  label: string;
}

/**
 * 业务域与事件动作的对应关系只能由行业包在员工 meta.coverage 中声明。
 * 基座不根据 action/preset 命名猜测行业语义，避免把某个行业的岗位表带入其他行业。
 */
function coverageDeclarations(meta: unknown): CoverageDeclaration[] {
  if (!meta || typeof meta !== "object") return [];
  const coverage = (meta as { coverage?: unknown }).coverage;
  if (!Array.isArray(coverage)) return [];
  return coverage.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as { eventPrefix?: unknown; event_prefix?: unknown; label?: unknown };
    const eventPrefix = typeof row.eventPrefix === "string"
      ? row.eventPrefix.trim()
      : typeof row.event_prefix === "string" ? row.event_prefix.trim() : "";
    const label = typeof row.label === "string" ? row.label.trim() : "";
    if (!eventPrefix || !label || !/[\u3400-\u9fff]/u.test(label)) return [];
    return [{ eventPrefix, label }];
  });
}

export async function scanOrgHealth(app: pg.Pool, scope: Scope): Promise<OrgHealth> {
  const c = await app.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const agents = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM agents WHERE workspace_id=$1 AND status='ready'`, [scope.workspaceId]);
    const backlog = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM approvals WHERE workspace_id=$1 AND status='pending' AND tier='l2_captain'`, [scope.workspaceId]);
    const domainOwners = await c.query<{ status: string; meta: unknown }>(
      `SELECT status, meta FROM agents WHERE workspace_id=$1`,
      [scope.workspaceId],
    );
    // 近 7 天出现的事件动作；只与行业包显式声明的覆盖前缀匹配。
    const actions = await c.query<{ action: string | null; n: string }>(
      `SELECT payload->'decision'->>'action' AS action, count(*)::text AS n FROM biz_events
       WHERE workspace_id=$1 AND created_at > now() - interval '7 days' GROUP BY 1 ORDER BY 2 DESC LIMIT 20`,
      [scope.workspaceId],
    );
    // 过载：产出 > 均值 2 倍且 > 20
    const perAgent = await c.query<{ who: string; n: string }>(
      `SELECT payload->'who'->>'id' AS who, count(*)::text AS n FROM biz_events
       WHERE workspace_id=$1 AND created_at > now() - interval '7 days' AND payload->'who'->>'type'='agent' AND payload->'who'->>'id' <> 'company-ceo'
       GROUP BY 1 ORDER BY 2 DESC`,
      [scope.workspaceId],
    ).catch(() => ({ rows: [] as Array<{ who: string; n: string }> }));
    await c.query("COMMIT");

    const declared = domainOwners.rows.flatMap((row) => coverageDeclarations(row.meta));
    const readyPrefixes = new Set(
      domainOwners.rows
        .filter((row) => row.status === "ready")
        .flatMap((row) => coverageDeclarations(row.meta).map((item) => item.eventPrefix)),
    );
    const uncovered = new Set<string>();
    for (const declaration of declared) {
      const hasActivity = actions.rows.some((row) =>
        typeof row.action === "string" && row.action.startsWith(declaration.eventPrefix));
      if (hasActivity && !readyPrefixes.has(declaration.eventPrefix)) uncovered.add(declaration.label);
    }
    const counts = perAgent.rows.map((r) => Number(r.n));
    const avg = counts.length ? counts.reduce((s, x) => s + x, 0) / counts.length : 0;
    const overworked = perAgent.rows
      .filter((r) => Number(r.n) > Math.max(avg * 2, 20))
      .map((r) => ({ agentId: r.who, outputs: Number(r.n) }));
    return {
      agentCount: Number(agents.rows[0]?.n ?? 0),
      backlog: Number(backlog.rows[0]?.n ?? 0),
      uncovered: [...uncovered],
      overworked,
    };
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally { c.release(); }
}

export interface HiringProposal {
  reason: string;
  role: string;              // 岗位（preset 建议）
  jd: { duty: string; skills: string[]; expected: string };
}

/** 招聘提案生成：覆盖缺口 / 积压 / 过载 → 提案（无缺口返回 null） */
export function proposeHiring(h: OrgHealth): HiringProposal | null {
  if (h.uncovered.length > 0) {
    const role = h.uncovered[0]!;
    return {
      reason: `业务域「${role}」近 7 天有经营活动但无专职数字员工（岗位覆盖缺口）`,
      role,
      jd: { duty: `负责 ${role} 域全流程运营`, skills: [role], expected: "该域事件有人承接、异常有人处置" },
    };
  }
  if (h.backlog >= 10) {
    return {
      reason: `二级审批队列积压 ${h.backlog} 件（不少于 10 件），裁决产能不足`,
      role: "运营协作员工",
      jd: { duty: "分担常规裁决与巡检", skills: ["审批复核", "日常巡检"], expected: "积压清零且日常少于 5 件" },
    };
  }
  if (h.overworked.length > 0) {
    return {
      reason: `一名数字员工产出 ${h.overworked[0]!.outputs} 件（超过均值 2 倍），存在单点过载`,
      role: "业务协作员工",
      jd: { duty: "分担同业务域的高频动作", skills: ["同域协作"], expected: "主员工负载降至均值 1.5 倍内" },
    };
  }
  return null;
}

/* ================= B-50：编制周报（P2 运营指标 / 退场条件 / 扩编触发） ================= */

export interface StaffingWeeklyInput {
  period: string;
  health: OrgHealth;
  proposal: HiringProposal | null;
  p2: P2Evaluation[];
}

export interface StaffingWeekly {
  period: string;
  text: string;
  needsChairman: boolean;
}

const P2_STATUS_LABEL: Record<P2Evaluation["status"], string> = {
  keep: "在营健康",
  watch: "观察",
  exit_proposal: "退场提案",
  no_data: "未取数",
};

/** 编制周报（纯函数）：覆盖缺口/积压/过载的扩编提案 + P2 条件岗指标与退场提案。 */
export function composeStaffingWeekly(input: StaffingWeeklyInput): StaffingWeekly {
  const p2Lines = input.p2.map((p) =>
    `${p.label}（${p.role}）：${P2_STATUS_LABEL[p.status]}${p.reasons.length > 0 ? `——${p.reasons.join("；")}` : ""}`);
  const needsChairman = Boolean(input.proposal) || input.p2.some((p) => p.status === "exit_proposal");
  const lines = [
    `【编制周报 · ${input.period}】`,
    `一、编制与负载：在岗 ${input.health.agentCount} 人 · L2 积压 ${input.health.backlog} 件 · 覆盖缺口 ${input.health.uncovered.length} 项 · 过载 ${input.health.overworked.length} 人`,
    input.proposal
      ? `二、扩编提案：${input.proposal.reason}；建议岗位「${input.proposal.role}」——${input.proposal.jd.expected}`
      : "二、扩编提案：本期无（覆盖缺口/积压/过载均未触发阈值）",
    input.p2.length > 0
      ? `三、P2 条件岗：${p2Lines.join(" · ")}`
      : "三、P2 条件岗：本期无声明运营指标（未激活或未声明）",
    needsChairman
      ? "四、请董事长裁决：扩编提案与退场提案需 L4 逐单批示，未批示前维持现状"
      : "四、无需裁决：编制与 P2 指标均在阈值内",
  ];
  return { period: input.period, text: lines.join("\n"), needsChairman };
}

/** 周标识：ISO 周（如 2026-W38），与指标事件的周键一致。 */
export function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * 从库里汇总编制周报：编制健康度 + P2 条件岗指标序列。
 * 指标序列约定：事件 `payload.decision.after.metrics` 为 `{ 指标键: 数值 }`（B-33 增长日表/B-11 采集写入）。
 * 未取数的 P2 岗如实标「未取数」，不虚报达标。
 */
export async function gatherStaffingWeekly(app: pg.Pool, scope: Scope, period = isoWeekKey(new Date())): Promise<StaffingWeekly> {
  const health = await scanOrgHealth(app, scope);
  const proposal = proposeHiring(health);
  const c = await app.connect();
  let defs: ReturnType<typeof loadP2RolesFromAgents> = [];
  const weekValues = new Map<string, Record<string, number>>();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const agents = await c.query<{ preset_key: string; meta: unknown }>(
      `SELECT preset_key, meta FROM agents
        WHERE workspace_id=$1 AND status='ready' AND meta ? 'ops_metrics'`,
      [scope.workspaceId],
    );
    defs = loadP2RolesFromAgents(agents.rows);
    const events = await c.query<{ week: string; metrics: Record<string, unknown> | null }>(
      `SELECT to_char(date_trunc('week', created_at), 'IYYY-"W"IW') AS week,
              payload->'decision'->'after'->'metrics' AS metrics
         FROM biz_events
        WHERE workspace_id=$1 AND created_at > now() - interval '12 weeks'
          AND payload->'decision'->'after' ? 'metrics'
        ORDER BY created_at`,
      [scope.workspaceId],
    );
    for (const row of events.rows) {
      if (!row.metrics || typeof row.metrics !== "object") continue;
      const bucket = weekValues.get(row.week) ?? {};
      for (const [key, value] of Object.entries(row.metrics)) {
        const n = Number(value);
        if (Number.isFinite(n)) bucket[key] = n;
      }
      weekValues.set(row.week, bucket);
    }
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally { c.release(); }
  const weeks = [...weekValues.entries()].map(([week, values]) => ({ week, values }));
  const p2 = defs.map((def) => evaluateP2Role(def, weeks));
  return composeStaffingWeekly({ period, health, proposal, p2 });
}
