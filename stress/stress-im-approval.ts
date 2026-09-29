/**
 * stress-im-approval.ts —— U-01 闭环：IM 通道手势批准 → 批准后钩子实弹（线程自动续跑）
 *
 * 背景（排雷台账 U-01）：B-05 的「批准≠执行」修复有三路入口（端内单笔 / 批量 / IM 手势），
 * 前两路有动态回归，**IM 手势这一路此前只有 typecheck 级验证**：mock 通道从未实弹走通
 * 「通道手势 → decide → onApproved → Quest 续跑」全链路。
 *
 * 本用例用真库 + 真服务 + 真审批单走通该链路（只有 IM 平台传输层是内存 mock，
 * 真实平台凭据属外部依赖，见 docs/LIVE-READINESS.md）：
 *   ① 真规划器产出一条 pending_review 线程 + 待批审批单（写类步骤挂起）；
 *   ② 绑定 openid → 走 im.callback（配了 IM_CHANNEL_SECRET_FEISHU 就走 HMAC 验签路径，
 *      否则走 P0-1 开发降级：仅允许会话成员本人 openid）；
 *   ③ 断言：审批落 approved、回执回写通道（F5.5）、**线程被批准后钩子真正续跑**（新事件/新挂起点）；
 *   ④ 负例：未映射 openid 403；重复回调幂等去重；验签开启时篡改签名 403。
 *
 * 前置：server 运行中（IM_DRIVER=mock 时可断言回执盒；真实驱动下跳过回执断言）。
 * 用法：IM_CHANNEL_SECRET_FEISHU=<与 server 同值> pnpm stress:im-approval
 */
import { createHmac } from "node:crypto";
import { check, login, ownerPool, gatewayPool, scene, step, summary, trpc, TrpcError, RUN_ID } from "./_helper.js";

const SCOPE = { tenantId: "tenant-demo", workspaceId: "ws-yunqi" };
const MEMBER = "MEM-001";
const CHANNEL = "feishu" as const;
const SECRET = process.env.IM_CHANNEL_SECRET_FEISHU;
const PORT = Number(process.env.SERVER_PORT ?? 8787);

/** 稳定 JSON（与 server stableStringify 同口径：对象键排序、数组保序） */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

/** 带自定义头的 tRPC 调用（验签需要 x-channel-timestamp / x-channel-signature；会话头与 dsh-im 桥同口径） */
async function trpcSigned<T>(path: string, input: unknown, headers: Record<string, string>): Promise<T> {
  const res = await fetch(`http://localhost:${PORT}/trpc/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${CALLBACK_TOKEN}`, ...headers },
    body: JSON.stringify(input),
  });
  const body = (await res.json()) as { result?: { data?: unknown }; error?: { message?: string; data?: { code?: string } } };
  if (body.error) throw new TrpcError(body.error.data?.code ?? "ERROR", body.error.message ?? "未知 tRPC 错误");
  return body.result?.data as T;
}

function signedHeaders(payload: unknown): Record<string, string> {
  if (!SECRET) return {};
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", SECRET).update(`${ts}.${stableStringify(payload)}`).digest("hex");
  return { "x-channel-timestamp": ts, "x-channel-signature": sig };
}

/** dsh-im 桥回调 server 时携带的会话令牌（writeProcedure 需要认证） */
let CALLBACK_TOKEN = "";

async function main(): Promise<void> {
  const db = ownerPool();
  const gw = gatewayPool();
  const app = ownerPool();
  const token = await login(); // 校验服务侧演示身份可用（失败即前置不满足）
  CALLBACK_TOKEN = token;
  step(`运行标识 ${RUN_ID}；验签模式=${SECRET ? "HMAC（IM_CHANNEL_SECRET_FEISHU 已配置）" : "P0-1 开发降级（未配置密钥，仅本人 openid）"}`);

  /* ---------- 现场准备：真实挂起审批（写类步骤 → pending_review + 待批单） ---------- */
  scene("U-01 现场：真实规划器挂起 → 通道手势批准 → 批准后钩子续跑");
  const { runQuest } = await import("@workloom/runtime");
  const max = await db.query<{ n: string }>(`SELECT public.threads_max_t_no() AS n`);
  const threadId = `T-${Number(max.rows[0]?.n ?? 100) + 1}`;
  const goal = `把周五主打款调价 5%（IM 手势批准用例 ${RUN_ID}）`;
  await db.query(
    `INSERT INTO threads (id, tenant_id, workspace_id, title, mode, status, created_by)
     VALUES ($1,$2,$3,$4,'quest','queued',$5)`,
    [threadId, SCOPE.tenantId, SCOPE.workspaceId, goal, MEMBER],
  );
  const first = await runQuest(app as never, gw as never, SCOPE, { threadId, goal, presetKey: "pricing-agent" });
  const approvalId = first.pendingApprovalId;
  if (first.status !== "pending_review" || !approvalId) {
    console.error(`现场准备失败：runQuest 返回 status=${first.status} approvalId=${approvalId ?? "无"}`);
    process.exit(2);
  }
  step(`线程 ${threadId} 挂起待审（status=${first.status}），审批单 ${approvalId}`);

  const openid = `ou-u01-${RUN_ID.toLowerCase()}`;
  const originalOpenids = (await db.query<{ im_openids: Record<string, string> }>(
    `SELECT im_openids FROM members WHERE workspace_id=$1 AND member_no=$2`, [SCOPE.workspaceId, MEMBER],
  )).rows[0]?.im_openids ?? {};
  await db.query(
    `UPDATE members SET im_openids = im_openids || $3::jsonb WHERE workspace_id=$1 AND member_no=$2`,
    [SCOPE.workspaceId, MEMBER, JSON.stringify({ [CHANNEL]: openid })],
  );
  const beforeSeq = Number((await db.query<{ seq: string }>(
    `SELECT COALESCE(MAX(seq),0)::text AS seq FROM biz_events WHERE workspace_id=$1 AND session_id=$2`,
    [SCOPE.workspaceId, threadId])).rows[0]?.seq ?? 0);

  try {
    /* ---------- 正例：通道手势批准 ---------- */
    const payload = {
      channel: CHANNEL,
      approvalId,
      operatorOpenId: openid,
      conversationId: `conv-u01-${RUN_ID}`,
      gesture: "approve" as const,
    };
    const res = await trpcSigned<{ approvalId: string; status: string; deduped: boolean; unsigned: boolean }>(
      "im.callback", payload, signedHeaders(payload));
    step(`im.callback → status=${res.status} deduped=${res.deduped} unsigned=${res.unsigned}`);
    check("U-01a 通道手势批准落库为 approved", res.status === "approved", `实际 ${res.status}`);
    check("U-01b 验签口径与配置一致（配置密钥→已验签；未配置→开发降级标注）",
      SECRET ? res.unsigned === false : res.unsigned === true, `unsigned=${res.unsigned}`);
    const apr = await db.query<{ status: string }>(`SELECT status FROM approvals WHERE approval_id=$1`, [approvalId]);
    check("U-01c approvals 行状态为 approved（与响应一致）", apr.rows[0]?.status === "approved", `实际 ${apr.rows[0]?.status}`);

    /* ---------- 批准后钩子实弹：线程必须续跑（新事件 / 新挂起点 / 终态） ---------- */
    let resumed = false;
    let evidence = "";
    for (let i = 0; i < 20 && !resumed; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      const after = await db.query<{ n: string; actions: string }>(
        `SELECT count(*)::text AS n, COALESCE(string_agg(DISTINCT payload->'decision'->>'action', ','),'') AS actions
           FROM biz_events WHERE workspace_id=$1 AND session_id=$2 AND seq > $3`,
        [SCOPE.workspaceId, threadId, beforeSeq]);
      const thr = await db.query<{ status: string }>(`SELECT status FROM threads WHERE id=$1`, [threadId]);
      const nextApr = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM approvals WHERE workspace_id=$1 AND approval_id <> $2
           AND event_id IN (SELECT event_id FROM biz_events WHERE session_id=$3)`,
        [SCOPE.workspaceId, approvalId, threadId]);
      evidence = `新增事件 ${after.rows[0]?.n} 条（${after.rows[0]?.actions || "无"}）线程态=${thr.rows[0]?.status} 新挂起单=${nextApr.rows[0]?.n}`;
      resumed = Number(after.rows[0]?.n ?? 0) > 0
        || thr.rows[0]?.status === "completed"
        || Number(nextApr.rows[0]?.n ?? 0) > 0;
    }
    step(`续跑证据：${evidence}`);
    check("U-01d 通道手势批准后批准后钩子必须实弹（线程出现续跑证据：新事件/新挂起点/终态）",
      resumed, evidence);

    /* ---------- 幂等：重复回调只处理首次（L5.3） ---------- */
    const dup = await trpcSigned<{ deduped: boolean }>("im.callback", payload, signedHeaders(payload));
    check("U-01e 重复手势回调必须幂等去重", dup.deduped === true, `deduped=${dup.deduped}`);

    /* ---------- 回执回写（F5.5；mock 驱动断言出站盒） ---------- */
    const driver = await trpc<{ driver: string; outbox: Array<{ kind: string; text?: string }> }>("im.outbox", {
      token, method: "query", input: { channel: CHANNEL },
    }).catch(() => null);
    if (driver?.driver === "mock") {
      const receipt = (driver.outbox ?? []).some((m) => m.kind === "text" && (m.text ?? "").includes(approvalId));
      check("U-01f 手势回执必须回写通道（F5.5，mock 出站盒可见）", receipt,
        `出站盒 ${driver.outbox.length} 条，含审批号=${receipt}`);
    } else {
      step(`IM_DRIVER=${driver?.driver ?? "unknown"}：真实驱动下回执在平台侧，跳过出站盒断言`);
    }

    /* ---------- 负例：未映射 openid（E5.2） ---------- */
    const unmapped = {
      channel: CHANNEL, approvalId, operatorOpenId: `ou-stranger-${RUN_ID}`, conversationId: "conv-x", gesture: "approve" as const,
    };
    const stranger = await trpcSigned("im.callback", unmapped, signedHeaders(unmapped))
      .then(() => ({ code: "OK" })).catch((err) => ({ code: err instanceof TrpcError ? err.code : "NON_TRPC" }));
    check("U-01g 未映射 openid 必须 403（外部联系人无权审批）", stranger.code === "FORBIDDEN", `code=${stranger.code}`);

    /* ---------- 负例：篡改签名 / 冒名他人（P0-1） ---------- */
    const other = { ...payload, operatorOpenId: `ou-other-${RUN_ID}`, gesture: "reject" as const };
    if (SECRET) {
      const tampered = await trpcSigned("im.callback", other, {
        "x-channel-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-channel-signature": "0".repeat(64),
      }).then(() => ({ code: "OK" })).catch((err) => ({ code: err instanceof TrpcError ? err.code : "NON_TRPC" }));
      check("U-01h 验签开启时签名不符必须 403（不落本人降级）", tampered.code === "FORBIDDEN", `code=${tampered.code}`);
    } else {
      const impersonate = await trpcSigned("im.callback", other, {})
        .then(() => ({ code: "OK" })).catch((err) => ({ code: err instanceof TrpcError ? err.code : "NON_TRPC" }));
      check("U-01h 未验签降级下冒名他人 openid 必须 403（仅本人可操作）", impersonate.code === "FORBIDDEN", `code=${impersonate.code}`);
    }
  } finally {
    await db.query(
      `UPDATE members SET im_openids = $3::jsonb WHERE workspace_id=$1 AND member_no=$2`,
      [SCOPE.workspaceId, MEMBER, JSON.stringify(originalOpenids)],
    );
    await db.query(`DELETE FROM approvals WHERE event_id IN (SELECT event_id FROM biz_events WHERE session_id=$2) AND workspace_id=$1`,
      [SCOPE.workspaceId, threadId]);
    await db.query(`DELETE FROM threads WHERE id=$1`, [threadId]);
    step("测试现场已清理（线程/审批单删除，biz_events 留档）");
  }

  await gw.end();
  await db.end();
  await app.end();
  summary();
}

main().catch((err) => { console.error(err); process.exit(2); });
