#!/usr/bin/env node
/**
 * acceptance:questline · 首日上岗（B-63/B-64/B-69）端到端验收
 *
 * 覆盖：
 *  ① 内容随包：按工作区 industry 装载 bundles/<id>/onboarding/questline.yml（四关定义齐备）；
 *  ② 服务端进度：按顺序推进 + 跳关拒绝 + 跳过单记 → 进度落 onboarding_progress（跨端续播的存储层）；
 *  ③ 账本：questline.started / stage.completed / stage.skipped / completed 四类事件齐备；
 *  ④ 首登行动卡：待放行关卡进行动卡（B-64）；
 *  ⑤ 漏斗：开始/完成/跳过与各关完成数（B-69，晨报栏位同口径）。
 * 沙箱：本脚本自建独立租户/工作区，跑完清理（不污染演示工作区）；失败非 0 退出。
 */
import { randomUUID } from "node:crypto";
import { getOwnerPool } from "@workloom/db";
import {
  advanceQuestline, firstActionCard, questlineFunnel, questlineState, replayQuestline,
} from "../../apps/server/src/service/questline.js";

let failed = 0;
const check = (ok: boolean, label: string, detail = ""): void => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` —— ${detail}` : ""}`);
  if (!ok) failed += 1;
};

const suffix = randomUUID().slice(0, 8);
const tenantId = `tenant-questline-${suffix}`;
const workspaceId = `ws-questline-${suffix}`;
const memberId = `mem-questline-${suffix}`;
const identity = { memberId, memberNo: "MEM-Q01", role: "owner" };
const owner = getOwnerPool();

try {
  await owner.query(`INSERT INTO tenants (id, name, plan) VALUES ($1,$2,'pro')`, [tenantId, "首日上岗验收租户"]);
  await owner.query(
    `INSERT INTO workspaces (id, tenant_id, name, slug, industry) VALUES ($1,$2,$3,$4,'geo-growth')`,
    [workspaceId, tenantId, "首日上岗验收工作区", `questline-${suffix}`],
  );
  await owner.query(
    `INSERT INTO members (id, workspace_id, member_no, name, role) VALUES ($1,$2,'MEM-Q01','验收董事长','owner')`,
    [memberId, workspaceId],
  );

  const { pack, progress } = await questlineState(workspaceId, identity);
  check(Boolean(pack), "内容随包装载（geo-growth）", pack ? `${pack.bundleId} · ${pack.stages.length} 关` : "");
  check(pack?.stages.map((s) => s.id).join(",") === "meet,goal,dispatch,review", "四关定义与叙事顺序一致");
  check(progress.persisted === false && progress.stage === "meet", "初始进度未开始（meet）");

  const first = await advanceQuestline(workspaceId, identity, { stage: "meet", outcome: "done", litCards: ["content", "ads"] });
  check(first.eventAction === "questline.started", "首次推进补写 questline.started（漏斗起点）");
  await expectReject(
    () => advanceQuestline(workspaceId, identity, { stage: "review", outcome: "done" }),
    /按顺序/,
    "跳关被拒（不接受越关推进）",
  );
  const skipped = await advanceQuestline(workspaceId, identity, { stage: "goal", outcome: "skip" });
  check(skipped.progress.skipped.includes("goal") && !skipped.progress.stageDone.includes("goal"), "跳过单记 skipped（不伪装成完成）");
  await advanceQuestline(workspaceId, identity, { stage: "dispatch", outcome: "done", lastThreadId: `T-acc-${suffix}` });
  const completed = await advanceQuestline(workspaceId, identity, { stage: "review", outcome: "done", achievements: ["first-close"] });
  check(completed.progress.status === "completed", "四关走完 → completed");

  const eventCounts = await owner.query<{ action: string; n: string }>(
    `SELECT payload->'decision'->>'action' AS action, count(*)::text AS n FROM biz_events
      WHERE workspace_id=$1 AND payload->'decision'->>'action' LIKE 'questline.%' GROUP BY 1`,
    [workspaceId],
  );
  const byAction = Object.fromEntries(eventCounts.rows.map((r) => [r.action, Number(r.n)]));
  check(byAction["questline.started"] === 1, "账本：questline.started ×1");
  check(byAction["questline.completed"] === 1, "账本：questline.completed ×1");
  check(byAction["questline.stage.skipped"] === 1, "账本：questline.stage.skipped ×1");

  const progressRow = await owner.query<{ status: string; state: Record<string, unknown> }>(
    `SELECT status, state FROM onboarding_progress WHERE workspace_id=$1 AND journey_key='day-1-questline'`,
    [workspaceId],
  );
  check(progressRow.rows[0]?.status === "completed", "进度行落库（跨设备续播存储层）");
  check(Array.isArray((progressRow.rows[0]?.state as { stageDone?: unknown }).stageDone), "进度 state 带 stageDone（续播读模型）");

  await owner.query(
    `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, tier, snapshot)
     VALUES ($1,$2,$3,'E-questline-acc','inapp','pending','l4_chairman',$4)`,
    [`apr-questline-${suffix}`, tenantId, workspaceId, JSON.stringify({ title: "开业预算放行" })],
  );
  const card = await firstActionCard(workspaceId, identity);
  check(card.items[0]?.id === "gate-first", "首登行动卡首条 = 待放行关卡（B-64）", card.items[0]?.title ?? "");
  check(card.items.length <= 3, "行动卡最多三件事", `items=${card.items.length}`);
  check(card.items.every((i) => i.source.length > 0), "每件事都带事实出处");

  const funnel = await questlineFunnel(workspaceId, 30);
  check(funnel.started === 1 && funnel.completed === 1 && funnel.skipped === 1, "漏斗：开始/完成/跳过齐备", JSON.stringify(funnel.stageDone));
  check(funnel.stageDone.review === 1, "漏斗：末关完成计入 review（questline.completed）");

  const replayed = await replayQuestline(workspaceId, identity);
  check(replayed.status === "not_started" && replayed.replayCount === 1, "重播清进度并计数（账本留痕）");
} finally {
  await owner.query(`DELETE FROM onboarding_progress WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
  await owner.query(`DELETE FROM approvals WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
  await owner.query(`DELETE FROM biz_events WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
  await owner.query(`DELETE FROM members WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
  await owner.query(`DELETE FROM workspaces WHERE id=$1`, [workspaceId]).catch(() => undefined);
  await owner.query(`DELETE FROM tenants WHERE id=$1`, [tenantId]).catch(() => undefined);
}

async function expectReject(fn: () => Promise<unknown>, pattern: RegExp, label: string): Promise<void> {
  try {
    await fn();
    check(false, label, "预期拒绝但通过了");
  } catch (error) {
    check(pattern.test(String((error as Error).message ?? error)), label, String((error as Error).message ?? error));
  }
}

console.log(failed === 0 ? "\n首日上岗验收通过" : `\n首日上岗验收失败：${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
