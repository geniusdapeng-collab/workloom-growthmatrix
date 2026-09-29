/**
 * 节拍调度器（BEATS-01）。
 *
 * 问题（2026-09-29 审计实证）：全系统只有三个常驻循环——线程调度器（7s 扫 queued）、
 * 技能分发自动同步（60s 评估）、C 端限流清扫（60s）。数字 CEO 的十二个节拍
 * （晨报/周会/月报/集团晨报/队列裁决/偏差扫描/熔断/回测/HR 评议/董事会包/编制扫描/路由复盘）
 * 与管线 YAML 里声明的 cron，此前**只有手动 tRPC 入口**，没有任何定时触发者——
 * 「无人操作时系统仍在经营」在运行层面不成立。
 *
 * 口径：
 *  - 进程内轻量循环（默认 60s 一 tick，`WORKLOOM_BEATS_ENABLED=0` 默认关闭，灰度开关是
 *    `WORKLOOM_BEATS_ENABLED=1` + 可选 `WORKLOOM_BEATS_WORKSPACES=<ws1,ws2>` 白名单）；
 *  - 节拍与管线 cron 统一落 `triggers` 表（`beat-*` 为内置节拍，其余由各行业/客户自建），
 *    幂等与多副本安全由 `tickTriggers` 的 `trigger_fires` + advisory 锁保证——重启同分钟不重复；
 *  - 命中后由本模块的 action 处理器执行：`beat` 直接调 captain 节拍函数（与手动入口同一实现），
 *    `dispatch` 生成一条 queued 线程（与巡检派单同构：同一事务内号源 + 建线程 + 事件留痕），
 *    随后由现有 7s 线程调度器接手执行 Quest；
 *  - 不可识别的 action 不静默丢弃：写 `trigger.dispatch_skipped` 事件并记日志（可审计）；
 *  - 单工作区失败不影响其它工作区；单 tick 内同工作区串行，避免与上一轮叠加。
 */
import type pg from "pg";
import { getAppPool, getGatewayPool, getOwnerPool } from "@workloom/db";
import { makeReadableId } from "@workloom/shared";
import {
  runBoardPackBeat,
  runBreakerBeat,
  runBriefingBeat,
  runDeviationBeat,
  runHrReviewBeat,
  runOrgScanBeat,
  runOutcomeReviewBeat,
  runQueueBeat,
  type Scope,
} from "@workloom/base/captain";
import { runRouterReviewBeat } from "@workloom/base/model-router";
import { tickTriggers, upsertTrigger, cronMatches, type FiredTrigger } from "@workloom/base/night-shift";
import { gatewayAppend, gatewayAppendOnClient } from "@workloom/base/workdata";
import { routedLlmCall, type LlmCall } from "../service/llm.js";

/* ================= 配置 ================= */

export interface BeatsOptions {
  /** tick 间隔（毫秒）；<=0 表示关闭 */
  intervalMs?: number;
  /** 工作区白名单（空 = 全部工作区） */
  workspaces?: string[];
}

const DEFAULT_INTERVAL_MS = 60_000;

export function beatsConfigFromEnv(): Required<BeatsOptions> {
  const raw = Number(process.env.WORKLOOM_BEATS_MS ?? DEFAULT_INTERVAL_MS);
  const intervalMs = Number.isFinite(raw) ? raw : DEFAULT_INTERVAL_MS;
  const workspaces = (process.env.WORKLOOM_BEATS_WORKSPACES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return { intervalMs, workspaces };
}

/** 总开关：默认关闭（`0`），显式 `1` 才启动（灰度纪律 §12） */
export function beatsEnabled(): boolean {
  return (process.env.WORKLOOM_BEATS_ENABLED ?? "0") === "1";
}

/* ================= 内置节拍表 ================= */

export type BuiltinBeat =
  | "daily"
  | "fleet_daily"
  | "weekly"
  | "monthly"
  | "queue"
  | "deviation"
  | "breaker"
  | "outcome"
  | "hr"
  | "board"
  | "orgscan"
  | "routerreview";

export interface BeatDefinition {
  /** 触发器 id（落 triggers 表；同 id 幂等 upsert） */
  id: string;
  /** 触发器名称（进事件与列表，中文可读） */
  name: string;
  /** 五字段 cron（分 时 日 月 周，Asia/Shanghai） */
  schedule: string;
  /** 执行的节拍 */
  beat: BuiltinBeat;
}

/**
 * 十二个内置节拍（与 `trpc.runBeat` 的枚举一一对应）。
 * 时点与各行业包 `pipelines/<管线>.yml` 的声明对齐：07:00 情报、08:30 决策包、22:00 夜班（由夜班状态机负责），
 * 节拍侧补上晨报/周会/月报/回测/HR/董事会/编制扫描/路由复盘，避免与管线抢占同分钟。
 */
export const DEFAULT_BEAT_TRIGGERS: BeatDefinition[] = [
  { id: "beat-daily", name: "每日晨报（08:30）", schedule: "30 8 * * *", beat: "daily" },
  { id: "beat-fleet-daily", name: "集团晨报（08:35）", schedule: "35 8 * * *", beat: "fleet_daily" },
  // 队列裁决排在偶数小时的 :40——避开 10:00 的回测与每月 1 日 10:00 的董事会包（同分钟只允许一个节拍）
  { id: "beat-queue", name: "L2 队列裁决（每 2 小时）", schedule: "40 */2 * * *", beat: "queue" },
  { id: "beat-deviation", name: "目标偏差扫描（每 4 小时）", schedule: "15 */4 * * *", beat: "deviation" },
  { id: "beat-breaker", name: "自治熔断检查（每小时）", schedule: "5 * * * *", beat: "breaker" },
  // 回测排在每日 10:20——每月 1 日 10:00 是董事会包、10:30 是月度复盘，三者按分钟错开
  { id: "beat-outcome", name: "决策回测（每日 10:20）", schedule: "20 10 * * *", beat: "outcome" },
  { id: "beat-weekly", name: "周经营会全稿（周一 09:30）", schedule: "30 9 * * 1", beat: "weekly" },
  { id: "beat-hr", name: "员工绩效评议（周一 11:00）", schedule: "0 11 * * 1", beat: "hr" },
  { id: "beat-orgscan", name: "编制健康度扫描（周一 11:30）", schedule: "30 11 * * 1", beat: "orgscan" },
  { id: "beat-routerreview", name: "路由质量复盘（周一 11:45）", schedule: "45 11 * * 1", beat: "routerreview" },
  { id: "beat-board", name: "月度董事会包（每月 1 日 10:00）", schedule: "0 10 1 * *", beat: "board" },
  { id: "beat-monthly", name: "月度复盘（每月 1 日 10:30）", schedule: "30 10 1 * *", beat: "monthly" },
];

/** 节拍 → 场景名（决定模型档位与降级链；无 LLM 时走确定性兜底） */
export const BEAT_SCENES: Record<BuiltinBeat, string | undefined> = {
  daily: "briefing",
  fleet_daily: "briefing",
  weekly: "briefing",
  monthly: "briefing",
  board: "briefing",
  queue: "ceo-decision",
  hr: "hr-replacement",
  deviation: undefined,
  breaker: undefined,
  outcome: undefined,
  orgscan: undefined,
  routerreview: undefined,
};

/* ================= 触发器登记 ================= */

/**
 * 把内置节拍登记进 `triggers` 表（只补缺失项，已存在不动——避免每次启动都写事件）。
 * 使用 `upsertTrigger` 而不是裸 SQL：触发器本身是围栏管辖对象，登记必须事件化（L4.4）。
 */
export async function ensureBeatTriggers(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  defs: BeatDefinition[] = DEFAULT_BEAT_TRIGGERS,
): Promise<{ created: string[] }> {
  const client = await app.connect();
  let existing: Set<string>;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const r = await client.query<{ id: string }>(
      `SELECT id FROM triggers WHERE workspace_id=$1 AND id = ANY($2::text[])`,
      [scope.workspaceId, defs.map((d) => d.id)],
    );
    existing = new Set(r.rows.map((row) => row.id));
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  const created: string[] = [];
  for (const def of defs) {
    if (existing.has(def.id)) continue;
    await upsertTrigger(app, gateway, scope, {
      id: def.id,
      name: def.name,
      kind: "cron",
      schedule: def.schedule,
      action: { beat: def.beat },
      createdBy: "beats-scheduler",
    });
    created.push(def.id);
  }
  return { created };
}

/* ================= action 处理器 ================= */

function beatLlm(scene: string | undefined, scope: Scope): LlmCall | undefined {
  if (!scene) return undefined;
  return routedLlmCall({
    gateway: getGatewayPool(),
    scope,
    scene,
    industryResolver: async () => workspaceIndustry(scope),
  });
}

async function workspaceIndustry(scope: Scope): Promise<string | null> {
  const client = await getAppPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    const r = await client.query<{ industry: string | null }>(`SELECT industry FROM workspaces WHERE id=$1`, [scope.workspaceId]);
    await client.query("COMMIT");
    return r.rows[0]?.industry ?? null;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** 执行一个 beat（与 tRPC `runBeat` 同一实现，参数语义一致） */
export async function runBuiltinBeat(beat: BuiltinBeat, scope: Scope, at: Date): Promise<Record<string, unknown>> {
  const app = getAppPool();
  const gateway = getGatewayPool();
  switch (beat) {
    case "daily":
    case "weekly":
    case "monthly":
    case "fleet_daily":
      return runBriefingBeat(app, scope, beat, { llmCall: beatLlm("briefing", scope) });
    case "queue":
      return runQueueBeat(app, scope, { llmCall: beatLlm("ceo-decision", scope) });
    case "deviation":
      return runDeviationBeat(app, scope);
    case "breaker":
      return runBreakerBeat(app, scope);
    case "outcome":
      return runOutcomeReviewBeat(app, scope);
    case "hr":
      return runHrReviewBeat(app, scope, { llmCall: beatLlm("hr-replacement", scope) });
    case "board":
      return runBoardPackBeat(app, scope, { llmCall: beatLlm("briefing", scope) });
    case "orgscan":
      return runOrgScanBeat(app, scope);
    case "routerreview":
      return runRouterReviewBeat(app, gateway, scope);
    default: {
      const exhaustive: never = beat;
      throw new Error(`未知节拍：${String(exhaustive)}（${at.toISOString()}）`);
    }
  }
}

/**
 * dispatch 型动作：生成一条 queued 线程（与巡检派单同构——同一事务内号源 + 建线程 + 事件）。
 * 线程由现有 7s 线程调度器接手，装配走 `runQuestForThread`（含行业规划器与围栏瀑布）。
 */
async function queueTriggerDispatch(
  scope: Scope,
  input: { triggerId: string; title: string; presetKey: string; firedEventId: string; at: Date },
): Promise<{ threadId: string; eventId: string }> {
  const app = getAppPool();
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const max = await client.query<{ n: number }>(`SELECT public.threads_max_t_no() AS n`);
    const threadId = makeReadableId("T", Number(max.rows[0]?.n ?? 100) + 1);
    await client.query(
      `INSERT INTO threads (id, tenant_id, workspace_id, title, mode, status, created_by, agent_id)
       VALUES ($1,$2,$3,$4,'quest','queued','beats-scheduler',$5)`,
      [threadId, scope.tenantId, scope.workspaceId, input.title, input.presetKey],
    );
    const ev = await gatewayAppendOnClient(client, {
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      actor: { id: "beats-scheduler", type: "system" },
    }, {
      who: { type: "system", id: "beats-scheduler" },
      context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: input.at.toISOString(), channel: "inapp" },
      object: { type: "staff", id: input.presetKey },
      decision: {
        action: "trigger.dispatched",
        after: { triggerId: input.triggerId, threadId, presetKey: input.presetKey, firedEventId: input.firedEventId },
        basis: ["节拍调度器按 cron 触发的自动派单（BEATS-01）", "线程由 7s 线程调度器接手执行，围栏瀑布不变"],
      },
      rule_impact: [],
    } as never);
    await client.query("COMMIT");
    return { threadId, eventId: ev.eventId };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** 不可识别的 action：留痕不静默（审计可查） */
async function recordSkippedTrigger(scope: Scope, fired: FiredTrigger, reason: string, at: Date): Promise<void> {
  await gatewayAppend(getGatewayPool(), { ...scope, actor: { id: "beats-scheduler", type: "system" } }, {
    who: { type: "system", id: "beats-scheduler" },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: at.toISOString(), channel: "inapp" },
    object: { type: "staff", id: fired.id },
    decision: { action: "trigger.dispatch_skipped", after: { triggerId: fired.id, firedEventId: fired.firedEventId, reason }, basis: ["不可识别的触发器动作：留痕不静默"] },
    rule_impact: [],
  } as never).catch((err) => {
    console.error("[beats] dispatch_skipped 留痕失败", err instanceof Error ? err.message : String(err));
  });
}

/** 处理单个已触发项：beat 直接执行；dispatch 建线程；其它留痕跳过 */
export async function dispatchFiredTrigger(
  scope: Scope,
  fired: FiredTrigger,
  at: Date,
): Promise<{ kind: "beat" | "dispatch" | "skipped"; result?: Record<string, unknown> }> {
  const action = fired.action ?? {};
  const beat = typeof action.beat === "string" ? (action.beat as BuiltinBeat) : undefined;
  if (beat && DEFAULT_BEAT_TRIGGERS.some((d) => d.beat === beat)) {
    const result = await runBuiltinBeat(beat, scope, at);
    return { kind: "beat", result };
  }
  const presetKey = typeof action.dispatch === "string" ? action.dispatch : undefined;
  if (presetKey) {
    const title = typeof action.title === "string" && action.title.trim().length > 0
      ? action.title
      : `${fired.name}：自动派单`;
    const r = await queueTriggerDispatch(scope, { triggerId: fired.id, title, presetKey, firedEventId: fired.firedEventId, at });
    return { kind: "dispatch", result: { threadId: r.threadId, eventId: r.eventId } };
  }
  await recordSkippedTrigger(scope, fired, `无法识别的 action 字段：${JSON.stringify(Object.keys(action))}`, at);
  return { kind: "skipped" };
}

/* ================= tick 与常驻循环 ================= */

export interface BeatsTickResult {
  workspaces: number;
  fired: number;
  beats: number;
  dispatched: number;
  skipped: number;
  failed: string[];
}

/**
 * 单次 tick：逐工作区（白名单过滤）登记缺失节拍 → tickTriggers 抢幂等 → 分派执行。
 * 单个工作区或单个触发器失败不影响其它；失败逐条收集返回（调用方记日志）。
 */
export async function runBeatsTick(at: Date = new Date(), opts: BeatsOptions = {}): Promise<BeatsTickResult> {
  const cfg = { ...beatsConfigFromEnv(), ...opts };
  const allow = new Set(cfg.workspaces);
  const app = getAppPool();
  const gateway = getGatewayPool();
  const owner = getOwnerPool();
  const result: BeatsTickResult = { workspaces: 0, fired: 0, beats: 0, dispatched: 0, skipped: 0, failed: [] };

  const wsClient = await owner.connect();
  let scopes: Scope[];
  try {
    const r = await wsClient.query<{ id: string; tenant_id: string }>(`SELECT id, tenant_id FROM workspaces ORDER BY id`);
    scopes = r.rows
      .map((row) => ({ tenantId: row.tenant_id, workspaceId: row.id }))
      .filter((s) => allow.size === 0 || allow.has(s.workspaceId));
  } finally {
    wsClient.release();
  }

  for (const scope of scopes) {
    result.workspaces += 1;
    try {
      await ensureBeatTriggers(app, gateway, scope);
      const fired = await tickTriggers(app, gateway, scope, at);
      result.fired += fired.length;
      for (const item of fired) {
        try {
          const outcome = await dispatchFiredTrigger(scope, item, at);
          if (outcome.kind === "beat") result.beats += 1;
          else if (outcome.kind === "dispatch") result.dispatched += 1;
          else result.skipped += 1;
        } catch (err) {
          const msg = `${scope.workspaceId}/${item.id}: ${err instanceof Error ? err.message : String(err)}`;
          result.failed.push(msg);
          console.error(`[beats] 触发器执行失败 ${msg}`);
        }
      }
    } catch (err) {
      const msg = `${scope.workspaceId}: ${err instanceof Error ? err.message : String(err)}`;
      result.failed.push(msg);
      console.error(`[beats] 工作区 tick 失败 ${msg}`);
    }
  }
  return result;
}

/** 启动节拍调度器（返回停止函数）；未开启开关时只做一次配置校验并返回空停止函数 */
export function startBeatsScheduler(opts: BeatsOptions = {}): () => void {
  if (!beatsEnabled()) {
    console.log("[beats] 未启用（WORKLOOM_BEATS_ENABLED!=1）：节拍保持手动入口，不写任何事件");
    return () => undefined;
  }
  const cfg = { ...beatsConfigFromEnv(), ...opts };
  if (cfg.intervalMs <= 0) return () => undefined;
  let running = false;
  const timer = setInterval(() => {
    if (running) return; // 上一轮未跑完不叠加（beat 可能等审批）
    running = true;
    void runBeatsTick(new Date(), cfg)
      .then((r) => {
        if (r.fired > 0 || r.failed.length > 0) {
          console.log(`[beats] tick：工作区 ${r.workspaces} · 触发 ${r.fired}（节拍 ${r.beats}/派单 ${r.dispatched}/跳过 ${r.skipped}）· 失败 ${r.failed.length}`);
        }
      })
      .catch((err) => console.error("[beats] tick 异常", err instanceof Error ? err.message : String(err)))
      .finally(() => { running = false; });
  }, cfg.intervalMs);
  timer.unref?.();
  const scopeLabel = cfg.workspaces.length > 0 ? cfg.workspaces.join(",") : "全部工作区";
  console.log(`[beats] 已启动：每 ${cfg.intervalMs}ms 评估一次节拍与触发器（范围：${scopeLabel}）`);
  return () => clearInterval(timer);
}

/** 供测试/诊断：给定时间点，返回应当触发的内置节拍 id 列表 */
export function dueBuiltinBeats(at: Date, defs: BeatDefinition[] = DEFAULT_BEAT_TRIGGERS): string[] {
  return defs.filter((d) => cronMatches(d.schedule, at)).map((d) => d.id);
}
