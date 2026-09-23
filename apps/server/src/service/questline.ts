/**
 * service · 首日上岗（Day-1 Questline）服务端事实源（B-63/B-64/B-69）
 *
 * 三件事：
 *  ① 内容随包：按工作区活动 Bundle 装载 `bundles/<id>/onboarding/questline.yml`（packages/base/bundles/onboarding.ts）；
 *  ② 进度服务端化：`onboarding_progress`（journey_key=day-1-questline）落 state JSONB，
 *     账号维度跨设备续播；每次推进写 `questline.*` 五元事件（账本为准，行只是投影）；
 *  ③ 首登行动卡：待放行关卡 + 续播下一步 + 待验收交付（buzhi 事实面，见 captain/action-card）。
 *
 * 纪律：GUEST 不落库（只读演示身份不得把某台浏览器的进度写成所有人的）；
 * 关卡推进只认"当前关"（跳步拒绝），跳过单独记 skipped（不伪装成完成）。
 */
import {
  loadQuestlinePack, questStageOf, QUEST_STAGE_IDS,
  type QuestlinePack, type QuestStageId,
} from "@workloom/base/bundles";
import { buildActionCard, type ActionCard, type ActionCardGate } from "@workloom/base/captain";
import { appendEventOn, serviceTx, svcQuery } from "./events.js";

const QUEST_JOURNEY = "day-1-questline";
export const QUEST_JOURNEY_VERSION = 1;

export interface QuestlineIdentity { memberId: string; memberNo: string; role: string }

export interface QuestlineProgress {
  persisted: boolean;
  status: "not_started" | "in_progress" | "completed";
  /** 当前待办关卡 */
  stage: QuestStageId;
  stageDone: QuestStageId[];
  skipped: QuestStageId[];
  achievements: string[];
  litCards: string[];
  lastThreadId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
  replayCount: number;
}

interface ProgressRow {
  status: "not_started" | "in_progress" | "completed";
  current_step: string;
  replay_count: number;
  updated_at: string;
  state: Record<string, unknown> | null;
}

const emptyProgress = (): QuestlineProgress => ({
  persisted: false, status: "not_started", stage: QUEST_STAGE_IDS[0],
  stageDone: [], skipped: [], achievements: [], litCards: [], lastThreadId: null,
  startedAt: null, completedAt: null, updatedAt: null, replayCount: 0,
});

const asStageArray = (value: unknown): QuestStageId[] =>
  Array.isArray(value) ? value.filter((v): v is QuestStageId => (QUEST_STAGE_IDS as readonly string[]).includes(String(v))) : [];
const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

function toProgress(row: ProgressRow | undefined): QuestlineProgress {
  if (!row) return emptyProgress();
  const state = (row.state ?? {}) as Record<string, unknown>;
  const stage = (QUEST_STAGE_IDS as readonly string[]).includes(row.current_step)
    ? row.current_step as QuestStageId
    : QUEST_STAGE_IDS[0];
  return {
    persisted: true,
    status: row.status,
    stage,
    stageDone: asStageArray(state.stageDone),
    skipped: asStageArray(state.skipped),
    achievements: asStringArray(state.achievements),
    litCards: asStringArray(state.litCards),
    lastThreadId: typeof state.lastThreadId === "string" ? state.lastThreadId : null,
    startedAt: typeof state.startedAt === "string" ? state.startedAt : null,
    completedAt: typeof state.completedAt === "string" ? state.completedAt : null,
    updatedAt: row.updated_at,
    replayCount: row.replay_count,
  };
}

async function subjectOf(client: import("pg").PoolClient, identity: QuestlineIdentity) {
  const r = await client.query<{ account_id: string | null }>(`SELECT account_id FROM members WHERE id=$1`, [identity.memberId]);
  const accountId = r.rows[0]?.account_id ?? null;
  return { accountId, identityKey: accountId ? `account:${accountId}` : `member:${identity.memberId}` };
}

async function readProgress(client: import("pg").PoolClient, workspaceId: string, identityKey: string, role: string) {
  const r = await client.query<ProgressRow>(
    `SELECT status, current_step, replay_count, updated_at, state
       FROM onboarding_progress
      WHERE workspace_id=$1 AND identity_key=$2 AND role=$3 AND journey_key=$4 AND journey_version=$5`,
    [workspaceId, identityKey, role, QUEST_JOURNEY, QUEST_JOURNEY_VERSION],
  );
  return r.rows[0];
}

/** 工作区活动 Bundle → 首日上岗内容包（未装内容包返回 null，前端据此不显示引导） */
export async function questlinePackForWorkspace(workspaceId: string): Promise<QuestlinePack | null> {
  const rows = await svcQuery<{ industry: string | null }>(workspaceId,
    `SELECT industry FROM workspaces WHERE id=$1`, [workspaceId]);
  const industry = rows[0]?.industry ?? null;
  return loadQuestlinePack(industry);
}

export async function questlineState(
  workspaceId: string, identity: QuestlineIdentity,
): Promise<{ pack: QuestlinePack | null; progress: QuestlineProgress }> {
  const pack = await questlinePackForWorkspace(workspaceId);
  if (identity.memberNo === "GUEST") return { pack, progress: emptyProgress() };
  const progress = await serviceTx(workspaceId, async (client) => {
    const subject = await subjectOf(client, identity);
    return toProgress(await readProgress(client, workspaceId, subject.identityKey, identity.role));
  });
  return { pack, progress };
}

export interface QuestlineAdvanceInput {
  stage: QuestStageId;
  outcome: "done" | "skip";
  /** 客户点亮的员工卡 id（第 1 关） */
  litCards?: string[];
  /** 派活关产生的真实线程号（第 3 关） */
  lastThreadId?: string | null;
  /** 本关新解锁成就 id（由客户端按事实判定，服务端只登记） */
  achievements?: string[];
}

/**
 * 推进一步：只允许推进"当前关"（跳步拒绝）；done → stageDone，skip → skipped；
 * 最后一关 done → completed（写 questline.completed）。首次推进补写 questline.started。
 */
export async function advanceQuestline(
  workspaceId: string, identity: QuestlineIdentity, input: QuestlineAdvanceInput,
): Promise<{ progress: QuestlineProgress; eventId: string | null; eventAction: string | null }> {
  const pack = await questlinePackForWorkspace(workspaceId);
  if (!pack) throw new Error("当前工作区未装配首日上岗内容包（Bundle 未声明 onboarding/questline.yml）");
  if (!(QUEST_STAGE_IDS as readonly string[]).includes(input.stage)) throw new Error(`未知关卡 ${input.stage}`);
  if (identity.memberNo === "GUEST") {
    // 游客：不落库、不写账本，回投影供前端本地续播
    const progress = emptyProgress();
    progress.status = "in_progress";
    progress.stage = input.stage;
    if (input.outcome === "done") progress.stageDone = [input.stage];
    else progress.skipped = [input.stage];
    return { progress, eventId: null, eventAction: null };
  }

  return serviceTx(workspaceId, async (client, scope) => {
    const subject = await subjectOf(client, identity);
    const row = await readProgress(client, workspaceId, subject.identityKey, identity.role);
    const current = toProgress(row);
    if (current.status === "completed") throw new Error("首日上岗已完成（要重走请先调用重播接口）");
    if (input.stage !== current.stage) {
      throw new Error(`关卡必须按顺序推进：当前是 ${current.stage}，收到 ${input.stage}（跳步拒绝）`);
    }
    const stageIndex = QUEST_STAGE_IDS.indexOf(input.stage);
    const stageDone = new Set(current.stageDone);
    const skipped = new Set(current.skipped);
    if (input.outcome === "done") stageDone.add(input.stage);
    else skipped.add(input.stage);
    const nextStage = QUEST_STAGE_IDS[Math.min(stageIndex + 1, QUEST_STAGE_IDS.length - 1)]!;
    const isLast = stageIndex === QUEST_STAGE_IDS.length - 1;
    const completed = input.outcome === "done" && isLast;
    const status = completed ? "completed" : "in_progress";
    const now = new Date().toISOString();
    const state = {
      stageDone: [...stageDone],
      skipped: [...skipped],
      achievements: [...new Set([...current.achievements, ...(input.achievements ?? [])])],
      litCards: [...new Set([...current.litCards, ...(input.litCards ?? [])])],
      lastThreadId: input.lastThreadId ?? current.lastThreadId,
      startedAt: current.startedAt ?? now,
      completedAt: completed ? now : current.completedAt,
    };
    await client.query(
      `INSERT INTO onboarding_progress
         (id, workspace_id, identity_key, account_id, member_id, role, journey_key, journey_version,
          status, current_step, state, started_at, completed_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now())
       ON CONFLICT (workspace_id, identity_key, role, journey_key, journey_version) DO UPDATE
         SET status=EXCLUDED.status, current_step=EXCLUDED.current_step, state=EXCLUDED.state,
             started_at=COALESCE(onboarding_progress.started_at, EXCLUDED.started_at),
             completed_at=EXCLUDED.completed_at, member_id=EXCLUDED.member_id,
             account_id=EXCLUDED.account_id, updated_at=now()`,
      [`obp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, workspaceId,
        subject.identityKey, subject.accountId, identity.memberId, identity.role,
        QUEST_JOURNEY, QUEST_JOURNEY_VERSION, status, completed ? "done" : nextStage,
        JSON.stringify(state), state.startedAt, state.completedAt],
    );

    const actor = { id: identity.memberNo, type: "human" as const };
    const objectId = `${workspaceId}:${subject.identityKey}`;
    let eventId: string | null = null;
    let eventAction: string | null = null;
    // 首次推进补写 questline.started（漏斗起点必须真实：没开始过就没有开始事件）
    if (!current.persisted || !current.startedAt) {
      const started = await appendEventOn(client, scope, actor, {
        objectType: "onboarding_questline", objectId,
        action: "questline.started",
        after: { journey: QUEST_JOURNEY, journeyVersion: QUEST_JOURNEY_VERSION, stage: input.stage, bundleId: pack.bundleId },
      });
      eventId = started.eventId;
      eventAction = "questline.started";
    }
    const advance = await appendEventOn(client, scope, actor, {
      objectType: "onboarding_questline", objectId,
      action: completed
        ? "questline.completed"
        : input.outcome === "done" ? "questline.stage.completed" : "questline.stage.skipped",
      after: {
        stage: input.stage, outcome: input.outcome, nextStage: completed ? null : nextStage,
        achievements: state.achievements, litCardsCount: state.litCards.length,
        lastThreadId: state.lastThreadId, bundleId: pack.bundleId,
      },
    });
    eventId = eventId ?? advance.eventId;
    eventAction = eventAction ?? (completed ? "questline.completed" : input.outcome === "done" ? "questline.stage.completed" : "questline.stage.skipped");
    return {
      progress: {
        persisted: true, status, stage: completed ? input.stage : nextStage,
        stageDone: [...stageDone], skipped: [...skipped], achievements: state.achievements,
        litCards: state.litCards, lastThreadId: state.lastThreadId,
        startedAt: state.startedAt, completedAt: state.completedAt, updatedAt: now,
        replayCount: current.replayCount,
      },
      eventId, eventAction,
    };
  });
}

/** 重播：与欢迎仪式同口径（清进度 + 计数 +1，账本留痕） */
export async function replayQuestline(
  workspaceId: string, identity: QuestlineIdentity,
): Promise<QuestlineProgress> {
  if (identity.memberNo === "GUEST") return emptyProgress();
  return serviceTx(workspaceId, async (client, scope) => {
    const subject = await subjectOf(client, identity);
    const r = await client.query<ProgressRow>(
      `INSERT INTO onboarding_progress
         (id, workspace_id, identity_key, account_id, member_id, role, journey_key, journey_version,
          status, current_step, state, started_at, replay_count, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'not_started','meet','{}'::jsonb,NULL,1,now())
       ON CONFLICT (workspace_id, identity_key, role, journey_key, journey_version) DO UPDATE
         SET status='not_started', current_step='meet', state='{}'::jsonb, completed_at=NULL,
             replay_count=onboarding_progress.replay_count+1,
             member_id=EXCLUDED.member_id, account_id=EXCLUDED.account_id, updated_at=now()
       RETURNING status, current_step, replay_count, updated_at, state`,
      [`obp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, workspaceId,
        subject.identityKey, subject.accountId, identity.memberId, identity.role,
        QUEST_JOURNEY, QUEST_JOURNEY_VERSION],
    );
    await appendEventOn(client, scope, { id: identity.memberNo, type: "human" }, {
      objectType: "onboarding_questline", objectId: `${workspaceId}:${subject.identityKey}`,
      action: "questline.replayed", after: { journey: QUEST_JOURNEY, stage: "meet" },
    });
    return toProgress(r.rows[0]);
  });
}

/**
 * B-64 首登行动卡：待放行关卡 + 首日上岗续播 + 待验收交付（+ 晨报提示），上限三件。
 * 事实来自 approvals / threads / 最新晨报事件，不编数。
 */
export async function firstActionCard(workspaceId: string, identity: QuestlineIdentity): Promise<ActionCard> {
  const { pack, progress } = await questlineState(workspaceId, identity);
  const gateRows = await svcQuery<{
    approval_id: string; tier: string | null; title: string | null; action: string | null;
    object_type: string | null; object_id: string | null; age_hours: string;
  }>(workspaceId,
    `SELECT a.approval_id, a.tier,
            COALESCE(a.snapshot->>'title', e.payload->'decision'->>'action', a.approval_id) AS title,
            COALESCE(a.snapshot->>'action', e.payload->'decision'->>'action') AS action,
            e.payload->'object'->>'type' AS object_type, e.payload->'object'->>'id' AS object_id,
            GREATEST(0, EXTRACT(EPOCH FROM (now() - a.created_at)) / 3600)::text AS age_hours
       FROM approvals a LEFT JOIN biz_events e ON e.event_id = a.event_id
      WHERE a.workspace_id=$1 AND a.status='pending'
      ORDER BY CASE a.tier WHEN 'l4_chairman' THEN 3 WHEN 'l3_fleet' THEN 2 ELSE 1 END DESC, a.created_at ASC
      LIMIT 5`,
    [workspaceId]);
  const gateRows2 = await svcQuery<{ running: string; pending_review: string }>(workspaceId,
    `SELECT count(*) FILTER (WHERE status='running')::text AS running,
            count(*) FILTER (WHERE status='pending_review')::text AS pending_review
       FROM threads WHERE workspace_id=$1`,
    [workspaceId]);
  const briefRows = await svcQuery<{ event_id: string; text: string | null }>(workspaceId,
    `SELECT event_id, payload->'decision'->'after'->>'text' AS text FROM biz_events
      WHERE workspace_id=$1 AND payload->'decision'->>'action'='ceo.briefing'
      ORDER BY seq DESC LIMIT 1`,
    [workspaceId]);

  const pendingGates: ActionCardGate[] = gateRows.map((r) => ({
    approvalId: r.approval_id,
    title: r.title ?? r.approval_id,
    tier: r.tier ?? "l2_captain",
    ageHours: Number(r.age_hours ?? 0),
    action: r.action, objectType: r.object_type, objectId: r.object_id,
  }));
  const stageIndex = QUEST_STAGE_IDS.indexOf(progress.stage);
  return buildActionCard({
    questline: pack
      ? {
        journeyName: pack.journeyName,
        stageTitle: questStageOf(pack, progress.stage).title,
        stageIndex: progress.status === "completed" ? pack.stages.length : stageIndex,
        totalStages: pack.stages.length,
        completed: progress.status === "completed",
      }
      : null,
    pendingGates,
    threads: {
      running: Number(gateRows2[0]?.running ?? 0),
      pendingReview: Number(gateRows2[0]?.pending_review ?? 0),
    },
    briefing: briefRows[0] ? { eventId: briefRows[0].event_id, text: briefRows[0].text ?? "" } : null,
  });
}

/** B-69 漏斗（供 tRPC/验收脚本查询；与晨报栏位同口径） */
export async function questlineFunnel(workspaceId: string, windowDays = 30): Promise<{
  started: number; completed: number; skipped: number;
  stageDone: Record<string, number>; skipRate: number | null;
}> {
  const rows = await svcQuery<{ action: string; stage: string | null; n: string }>(workspaceId,
    `SELECT payload->'decision'->>'action' AS action,
            COALESCE(payload->'decision'->'after'->>'stage','') AS stage, count(*)::text AS n
       FROM biz_events
      WHERE workspace_id=$1 AND payload->'decision'->>'action' LIKE 'questline.%'
        AND created_at > now() - ($2 || ' days')::interval
      GROUP BY 1,2`,
    [workspaceId, String(windowDays)]);
  const started = rows.filter((r) => r.action === "questline.started").reduce((n, r) => n + Number(r.n), 0);
  const completed = rows.filter((r) => r.action === "questline.completed").reduce((n, r) => n + Number(r.n), 0);
  const skipped = rows.filter((r) => r.action === "questline.stage.skipped").reduce((n, r) => n + Number(r.n), 0);
  const stageDone: Record<string, number> = {};
  for (const r of rows) {
    // 末关的完成记在 questline.completed（stage 字段仍带关卡名）：漏斗必须把它计入该关，
    // 否则"最后一关完成数"永远是 0，漏斗图会歪
    if ((r.action === "questline.stage.completed" || r.action === "questline.completed") && r.stage) {
      stageDone[r.stage] = (stageDone[r.stage] ?? 0) + Number(r.n);
    }
  }
  return { started, completed, skipped, stageDone, skipRate: started > 0 ? skipped / (started * QUEST_STAGE_IDS.length) : null };
}
