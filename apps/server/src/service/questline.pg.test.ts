/**
 * B-63/B-64/B-69 首日上岗服务端事实源 · 活库契约：
 *  ① 内容随包（按工作区 industry 装载）+ 进度服务端持久化（跨设备续播的存储层）；
 *  ② 只允许按顺序推进；跳过单记 skipped；最后一关 done → completed；
 *  ③ 账本写 questline.started / stage.completed / stage.skipped / completed；
 *  ④ 漏斗与行动卡读的是账本/队列事实；游客身份不落库。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  advanceQuestline, firstActionCard, questlineFunnel, questlineState, replayQuestline,
} from "./questline.js";

process.env.DATABASE_URL ??= "postgres://postgres:workloom@localhost:5432/workloom";
process.env.DATABASE_APP_URL ??= "postgres://workloom_app:workloom_dev_app@localhost:5432/workloom";

const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_APP_URL);
const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const tenantId = `tenant-quest-${suffix}`;
const workspaceId = `ws-quest-${suffix}`;
const memberId = `mem-quest-${suffix}`;
const identity = { memberId, memberNo: "MEM-Q01", role: "owner" };

describe.runIf(RUN_DB)("B-63 首日上岗服务端化", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  beforeAll(async () => {
    await owner.query(`INSERT INTO tenants (id, name, plan) VALUES ($1,$2,'pro')`, [tenantId, "首日上岗测试租户"]);
    await owner.query(
      `INSERT INTO workspaces (id, tenant_id, name, slug, industry) VALUES ($1,$2,$3,$4,'geo-growth')`,
      [workspaceId, tenantId, "首日上岗测试工作区", `quest-${suffix}`],
    );
    await owner.query(
      `INSERT INTO members (id, workspace_id, member_no, name, role) VALUES ($1,$2,'MEM-Q01','测试董事长','owner')`,
      [memberId, workspaceId],
    );
  });

  afterAll(async () => {
    await owner.query(`DELETE FROM onboarding_progress WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM approvals WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM biz_events WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM members WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM workspaces WHERE id=$1`, [workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM tenants WHERE id=$1`, [tenantId]).catch(() => undefined);
    await owner.end();
  });

  it("内容随包：工作区 industry=geo-growth → 装载该包内容与四关定义", async () => {
    const { pack, progress } = await questlineState(workspaceId, identity);
    expect(pack?.bundleId).toBe("geo-growth");
    expect(pack?.stages.map((s) => s.id)).toEqual(["meet", "goal", "dispatch", "review"]);
    expect(progress.persisted).toBe(false);
    expect(progress.stage).toBe("meet");
  });

  it("顺序推进 + 跳过单记 + 完成落账（含 started 起点事件）", async () => {
    const first = await advanceQuestline(workspaceId, identity, { stage: "meet", outcome: "done", litCards: ["content", "ads"] });
    expect(first.progress.stage).toBe("goal");
    expect(first.progress.stageDone).toEqual(["meet"]);
    expect(first.progress.litCards).toEqual(["content", "ads"]);
    expect(first.eventAction).toBe("questline.started");

    // 跳步拒绝
    await expect(advanceQuestline(workspaceId, identity, { stage: "review", outcome: "done" })).rejects.toThrow(/按顺序/);

    const skipped = await advanceQuestline(workspaceId, identity, { stage: "goal", outcome: "skip" });
    expect(skipped.progress.skipped).toEqual(["goal"]);
    expect(skipped.progress.stageDone).toEqual(["meet"]); // 跳过不进 stageDone（不伪装完成）
    expect(skipped.eventAction).toBe("questline.stage.skipped");

    await advanceQuestline(workspaceId, identity, { stage: "dispatch", outcome: "done", lastThreadId: "T-quest-1" });
    const done = await advanceQuestline(workspaceId, identity, { stage: "review", outcome: "done", achievements: ["first-close"] });
    expect(done.progress.status).toBe("completed");
    expect(done.progress.lastThreadId).toBe("T-quest-1");
    expect(done.progress.achievements).toEqual(["first-close"]);
    await expect(advanceQuestline(workspaceId, identity, { stage: "review", outcome: "done" })).rejects.toThrow(/已完成/);

    const events = await owner.query<{ action: string; n: string }>(
      `SELECT payload->'decision'->>'action' AS action, count(*)::text AS n FROM biz_events
        WHERE workspace_id=$1 AND payload->'decision'->>'action' LIKE 'questline.%' GROUP BY 1 ORDER BY 1`,
      [workspaceId],
    );
    const byAction = Object.fromEntries(events.rows.map((r) => [r.action, Number(r.n)]));
    expect(byAction["questline.started"]).toBe(1);
    // 前 3 关记 stage.completed（meet/dispatch；goal 被跳过），末关完成记 questline.completed
    expect(byAction["questline.stage.completed"]).toBe(2);
    expect(byAction["questline.stage.skipped"]).toBe(1);
    expect(byAction["questline.completed"]).toBe(1);
    // 进度行落库（跨设备续播的存储层），state 里带完整进度
    const row = await owner.query<{ state: Record<string, unknown>; status: string }>(
      `SELECT state, status FROM onboarding_progress WHERE workspace_id=$1 AND journey_key='day-1-questline'`,
      [workspaceId],
    );
    expect(row.rows[0]?.status).toBe("completed");
    expect((row.rows[0]?.state as { stageDone?: string[] }).stageDone).toEqual(["meet", "dispatch", "review"]);
  });

  it("漏斗与行动卡读事实：跳过率 = 跳过次数 / (开始 × 关卡数)；待放行关卡进行动卡", async () => {
    const funnel = await questlineFunnel(workspaceId, 30);
    expect(funnel.started).toBe(1);
    expect(funnel.completed).toBe(1);
    expect(funnel.skipped).toBe(1);
    expect(funnel.stageDone).toMatchObject({ meet: 1, dispatch: 1, review: 1 });
    expect(funnel.skipRate).toBeCloseTo(1 / 4, 5);

    await owner.query(
      `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, tier, snapshot)
       VALUES ($1,$2,$3,'E-quest-gate','inapp','pending','l4_chairman',$4)`,
      [`apr-quest-${suffix}`, tenantId, workspaceId, JSON.stringify({ title: "旗舰店开业预算放行" })],
    );
    const card = await firstActionCard(workspaceId, identity);
    expect(card.items[0]!.id).toBe("gate-first");
    expect(card.items[0]!.title).toContain("旗舰店开业预算放行");
    expect(card.pendingGates.map((g) => g.approvalId)).toContain(`apr-quest-${suffix}`);
    // 首日上岗已完成 → 不再出现续播项
    expect(card.items.some((i) => i.id === "questline-resume")).toBe(false);
  });

  it("重播清进度并计数；游客身份不落库不写账本", async () => {
    const replayed = await replayQuestline(workspaceId, identity);
    expect(replayed.status).toBe("not_started");
    expect(replayed.replayCount).toBe(1);
    const guest = await questlineState(workspaceId, { memberId: "nobody", memberNo: "GUEST", role: "readonly" });
    expect(guest.progress.persisted).toBe(false);
    const guestAdvance = await advanceQuestline(workspaceId, { memberId: "nobody", memberNo: "GUEST", role: "readonly" }, { stage: "meet", outcome: "done" });
    expect(guestAdvance.eventId).toBeNull();
    const guestRows = await owner.query(`SELECT 1 FROM onboarding_progress WHERE workspace_id=$1 AND identity_key LIKE 'member:nobody%'`, [workspaceId]);
    expect(guestRows.rows).toHaveLength(0);
  });
});
