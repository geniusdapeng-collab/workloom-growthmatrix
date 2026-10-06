/**
 * stress-threads.ts —— 任务派遣链动态排雷（对应静态台账 A-02 / A-03 / A-07 + 边界注入 + 越权）
 * 前置：明确授权的本机 mock 审计库和运行中的 server；不得接客户库。
 * queued 不占运行位；运行位由近期心跳的 running 线程占用。
 * 唯一后缀 RUN_ID 保证可复跑，号源故障注入与测试线程在 finally 中恢复。
 */
import { check, login, ownerPool, scene, step, summary, trpc, TrpcError, RUN_ID } from "./_helper.js";
import { closeAllPools } from "../packages/db/src/index.js";
import { sweepQueuedThreads } from "../apps/server/src/runtime/scheduler.js";

const SCOPE = { tenantId: "tenant-demo", workspaceId: "ws-yunqi" };
const CONCURRENCY_LIMIT = 10; // L3.1：单工作区并发 ≤10

/** 当前占用并发位（与 Router 判定同口径：仅有近期心跳的 running） */
async function occupancy(db: { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<{ c: number }> }> }): Promise<number> {
  const r = await db.query(
    `SELECT count(*)::int AS c FROM threads
      WHERE workspace_id=$1
        AND status='running' AND updated_at > now() - interval '10 minutes'`,
    [SCOPE.workspaceId],
  );
  return r.rows[0]?.c ?? 0;
}

/** 失败面口径：不得 500、不得泄漏 PG 原文；并发上限/号源冲突必须是业务码 */
function classifyFailure(err: unknown): { code: string; leak: boolean; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof TrpcError ? err.code : "NON_TRPC";
  const leak = /current transaction is aborted|duplicate key value|violates|relation "|PG::|pg_\w+ \(/i.test(message);
  return { code, leak, message };
}

async function main(): Promise<void> {
  const target = new URL(process.env.DATABASE_URL ?? "");
  if (process.env.STRESS_ALLOW_FAULT_INJECTION !== "1" || process.env.LLM_PROVIDER !== "mock"
      || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)
      || !/^\/[a-z0-9_]+_audit$/u.test(target.pathname)
      || !/^\d{10,30}$/u.test(process.env.STRESS_DB_SYSTEM_IDENTIFIER ?? "")) {
    throw new Error("线程故障注入仅允许显式授权、实例身份已绑定的本机 mock 审计库");
  }
  const db = ownerPool();
  const createdIds: string[] = [];
  let restoreNumberSource: string | undefined;
  try {
  const instance = await db.query<{ system_identifier: string }>("SELECT system_identifier::text FROM pg_control_system()");
  if (instance.rows[0]?.system_identifier !== process.env.STRESS_DB_SYSTEM_IDENTIFIER) {
    throw new Error("审计库实例身份不符，拒绝故障注入");
  }
  const token = await login();
  step(`运行标识 ${RUN_ID}`);

  /* ---------- A-02 ask 线程被调度器当 quest 执行（模拟 runAsk 进行中的 queued ask 线程） ---------- */
  scene("A-02 调度器不得把 ask 问询线程当 Quest 执行");
  const askId = `T-ASK-${RUN_ID}`;
  createdIds.push(askId);
  await db.query(
    `INSERT INTO threads (id, tenant_id, workspace_id, title, status, mode, created_by)
     VALUES ($1,$2,$3,$4,'queued','ask','stress')`,
    [askId, SCOPE.tenantId, SCOPE.workspaceId, `stress·问询线程 ${RUN_ID}`],
  );
  const questControl = `T-SCHEDULER-${RUN_ID}`;
  createdIds.push(questControl);
  await db.query(
    `INSERT INTO threads (id,tenant_id,workspace_id,title,status,mode,created_by)
     VALUES ($1,$2,$3,$4,'queued','quest','stress')`,
    [questControl, SCOPE.tenantId, SCOPE.workspaceId, `整理今日运营简报 ${RUN_ID}`],
  );
  const sweeps = [await sweepQueuedThreads({ batch: 10 }), await sweepQueuedThreads({ batch: 10 })];
  step(`实际执行两轮产品调度器；认领 ${sweeps.flatMap((result) => result.picked).join(",") || "无"}`);
  check("A-02c 同场 quest 对照被实际调度器认领", sweeps.some((result) => result.picked.includes(questControl)));
  const th = await db.query<{ status: string; mode: string }>(`SELECT status, mode FROM threads WHERE id=$1`, [askId]);
  const ev = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM biz_events
      WHERE payload->'object'->>'id' = $1
        AND payload->'decision'->>'action' IN ('quest.plan','quest.step.execute','tool.execute','thread.dispatch','quest.step')`,
    [askId]);
  const evAny = await db.query<{ n: string; actions: string }>(
    `SELECT count(*)::text AS n, coalesce(string_agg(DISTINCT payload->'decision'->>'action', ','),'') AS actions
       FROM biz_events WHERE payload->'object'->>'id' = $1`, [askId]);
  step(`现状：status=${th.rows[0]?.status} mode=${th.rows[0]?.mode} quest类事件=${ev.rows[0]?.n} 全部事件=${evAny.rows[0]?.n}（${evAny.rows[0]?.actions || "无"}）`);
  check("A-02a ask 线程不得被调度器迁移出 queued 去执行", th.rows[0]?.status === "queued", `实际 ${th.rows[0]?.status}`);
  check("A-02b ask 线程不得产生 quest 规划/执行事件", ev.rows[0]?.n === "0", `实际 ${ev.rows[0]?.n} 条`);
  await db.query(`DELETE FROM threads WHERE id=ANY($1)`, [[askId, questControl]]);

  /* ---------- A-03/A-07 并发派遣 12 路：全部成功 + 线程号唯一 ---------- */
  scene("A-03/A-07 12 路并发派遣（号源唯一性 / 无重入）");
  const occupancyBefore = await occupancy(db);
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, (_, i) =>
      trpc<{ kind?: string; threadId?: string }>("threads.dispatch", {
        token, method: "mutation",
        input: { title: `stress·并发派遣 ${RUN_ID}-${i}：整理一条今日运营简报`, runImmediately: false },
      }),
    ),
  );
  const okIds = results
    .map((r) => (r.status === "fulfilled" ? (r.value.threadId ?? null) : null))
    .filter((x): x is string => typeof x === "string");
  const failedN = results.length - okIds.length;
  createdIds.push(...okIds);
  const failures = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => classifyFailure(r.reason));
  step(`成功 ${okIds.length}/12，失败 ${failedN}（派遣前运行位 ${occupancyBefore}；${failures.map((f) => `${f.code}:${f.message.slice(0, 40)}`).join(" | ") || "无"}）`);
  /**
   * 修复后口径：queued 可等待调度，不占运行位；号源仍须并发唯一。
   * 调度器实际启动时在同一事务内分配运行位，满 running 时派遣返回业务码。
   */
  check("A-07 12 路 queued 派遣全部建档成功", okIds.length === 12 && failures.length === 0, `成功 ${okIds.length}，失败 ${failures.length}`);
  const afterBurst = await occupancy(db);
  check("A-07e queued 建档不增加运行位占用", afterBurst === occupancyBefore, `派遣前 ${occupancyBefore} / 派遣后 ${afterBurst}`);
  check("A-07d 派遣后占用并发位不得超过上限（并发上限竞争）", afterBurst <= CONCURRENCY_LIMIT, `占用 ${afterBurst}/${CONCURRENCY_LIMIT}`);
  if (okIds.length) {
    const dup = await db.query<{ id: string; n: string }>(
      `SELECT id, count(*)::text AS n FROM threads WHERE id = ANY($1) GROUP BY id HAVING count(*) > 1`, [okIds]);
    const missing = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM threads WHERE id = ANY($1)`, [okIds]);
    check("A-07b 派遣线程全部落库且无撞号", dup.rows.length === 0 && missing.rows[0]?.n === String(okIds.length),
      `落库 ${missing.rows[0]?.n}/${okIds.length}`);
    // 用例自带清理（账本事件留档）：并发位还给后续 U-03 用例，避免"前一个用例把库打满"导致假红
    await db.query(`DELETE FROM threads WHERE id = ANY($1)`, [okIds]);
    step(`A-07 测试线程已清理 ${okIds.length} 条（biz_events 留档不动）`);
  }

  /* ---------- U-03 并发上限竞争 + 号源撞号（排雷台账 U-03：500 泄漏 PG 原文 / 占用冲到 13/10） ---------- */
  scene("U-03 并发上限竞争与号源撞号（不得 500、不得泄漏 PG 原文、占用不得超限）");
  const u03Prefix = `U03·${RUN_ID}`;

  // ① 号源撞号故障注入：函数恒返回同一号 → 首单成功、次单必须业务 409（此前 25P02 500 泄漏 PG 原文）
  const originalFn = (await db.query<{ def: string }>(
    `SELECT pg_get_functiondef('public.threads_max_t_no()'::regprocedure) AS def`)).rows[0]?.def;
  if (!originalFn) {
    check("U-03d 号源撞号必须返回业务 409（不泄漏 PG 原文）", false, "无法读取号源函数定义，故障注入跳过");
  } else if ((await occupancy(db)) >= CONCURRENCY_LIMIT) {
    check("U-03d 号源撞号必须返回业务 409（不泄漏 PG 原文）", false,
      `占用已满 ${await occupancy(db)}/${CONCURRENCY_LIMIT}，撞号路径不可达（环境未腾出并发位）`);
  } else {
    const floor = Number((await db.query<{ n: string }>(
      `SELECT COALESCE(MAX(NULLIF(regexp_replace(id,'[^0-9]','','g'),'')::bigint),100)::text AS n
         FROM threads WHERE id ~ '^T-[0-9]+$'`)).rows[0]?.n ?? 100);
    let injected = false;
    try {
      await db.query(
        `CREATE OR REPLACE FUNCTION public.threads_max_t_no()
         RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path = public
         AS $$ SELECT ${floor + 1}::bigint $$`);
      injected = true;
      restoreNumberSource = originalFn;
      const hitTitle = `${u03Prefix}·撞号单 ${Date.now().toString(36)}`;
      const first = await trpc<{ threadId: string }>("threads.dispatch", { token, method: "mutation", input: { title: hitTitle, runImmediately: false } });
      createdIds.push(first.threadId);
      check("U-03g 号源直接落库且首单占用恒定号", first.threadId === `T-${floor + 1}`, `实际 ${first.threadId}`);
      const second = await trpc("threads.dispatch", {
        token, method: "mutation", input: { title: `${hitTitle}-次单`, runImmediately: false },
      }).then(() => ({ code: "OK", leak: false, message: "" })).catch((err) => classifyFailure(err));
      step(`撞号次单：code=${second.code} leak=${second.leak ? "YES" : "no"} message=${second.message.slice(0, 80)}`);
      check("U-03d 号源撞号重试耗尽必须返回业务 409（不得 500 / 泄漏 PG 原文）",
        second.code === "CONFLICT" && !second.leak, `code=${second.code} leak=${second.leak}`);
      const halfThreads = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM threads WHERE workspace_id=$1 AND title = $2`, [SCOPE.workspaceId, `${hitTitle}-次单`]);
      const halfEvents = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM biz_events
          WHERE workspace_id=$1 AND payload->'decision'->>'action'='thread.dispatch'
            AND payload->'decision'->'after'->>'title' = $2`, [SCOPE.workspaceId, `${hitTitle}-次单`]);
      check("U-03e 失败请求不得留下半截线程/账本",
        halfThreads.rows[0]?.n === "0" && halfEvents.rows[0]?.n === "0",
        `线程 ${halfThreads.rows[0]?.n} 条 / 事件 ${halfEvents.rows[0]?.n} 条`);
    } finally {
      if (injected) { await db.query(originalFn); restoreNumberSource = undefined; }
    }
    const restored = (await db.query<{ ok: boolean }>(
      `SELECT position('nextval' in pg_get_functiondef('public.threads_max_t_no()'::regprocedure)) > 0 AS ok`)).rows[0]?.ok === true;
    check("U-03f 故障注入后号源函数必须还原（含 nextval）", restored, restored ? "" : "函数未还原，需人工检查");
  }
  // 清掉撞号注入造的线程，把并发位还给下面的"打满→冲击"用例
  await db.query(`DELETE FROM threads WHERE workspace_id=$1 AND title LIKE $2`, [SCOPE.workspaceId, `${u03Prefix}·撞号单%`]);

  // ② 并发上限竞争：先填满并发位，再并发冲击——占用不得超限，拒绝必须是业务码
  const fillCount = Math.max(0, CONCURRENCY_LIMIT - await occupancy(db));
  for (let i = 0; i < fillCount; i += 1) {
    const id = `T-STRESS-RUN-${RUN_ID}-${i}`;
    createdIds.push(id);
    await db.query(`INSERT INTO threads (id,tenant_id,workspace_id,title,status,mode,created_by,updated_at)
      VALUES ($1,$2,$3,$4,'running','ask','stress',now())`, [id,SCOPE.tenantId,SCOPE.workspaceId,`${u03Prefix}·填充 ${i}`]);
  }
  step(`已造 ${fillCount} 条 running 夹具，占用 ${await occupancy(db)}/${CONCURRENCY_LIMIT}`);
  check("U-03h running 夹具实际填满运行位", await occupancy(db) === CONCURRENCY_LIMIT);
  const burst = await Promise.allSettled(Array.from({ length: 6 }, (_, i) =>
    trpc("threads.dispatch", {
      token, method: "mutation", input: { title: `${u03Prefix}·越限 ${i}`, runImmediately: false },
    })));
  const burstOk = burst.filter((r) => r.status === "fulfilled").length;
  const burstFail = burst
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => classifyFailure(r.reason));
  step(`越限并发冲击 6 路：成功 ${burstOk}，失败 ${burstFail.length}（${burstFail.map((f) => f.code).join(",") || "无"}）`);
  check("U-03a 打满并发位后继续派遣必须被业务拒绝（不得静默超限）",
    burstOk === 0 && burstFail.length === 6, `成功 ${burstOk}，拒绝 ${burstFail.length}`);
  check("U-03b 拒绝必须是业务码（429/409）且不泄漏 PG 原文",
    burstFail.every((f) => (f.code === "TOO_MANY_REQUESTS" || f.code === "CONFLICT") && !f.leak),
    burstFail.map((f) => `${f.code}${f.leak ? "(泄漏)" : ""}`).join(",") || "无失败");
  const afterU03 = await occupancy(db);
  check("U-03c 并发冲击后占用并发位不得超限", afterU03 <= CONCURRENCY_LIMIT, `占用 ${afterU03}/${CONCURRENCY_LIMIT}`);
  await db.query(`DELETE FROM threads WHERE workspace_id=$1 AND title LIKE $2`, [SCOPE.workspaceId, `${u03Prefix}%`]);

  /* ---------- 边界值：注入式 / 空参 / 超长 ---------- */
  scene("边界值（注入式输入 / 空标题 / 超长标题）");
  const inj = await trpc<{ threadId?: string; kind?: string }>("threads.dispatch", {
    token, method: "mutation",
    input: { title: `'); DROP TABLE threads;-- ${RUN_ID}`, runImmediately: false },
  }).catch((err) => ({ error: String(err) }));
  if ("threadId" in inj && inj.threadId) createdIds.push(inj.threadId);
  const alive = await db.query(`SELECT 1 FROM threads LIMIT 1`).then(() => true).catch(() => false);
  check("INJ-1 注入式标题不造成破坏且服务存活", alive, `响应 ${JSON.stringify(inj).slice(0, 60)}`);
  const empty = await trpc("threads.dispatch", { token, method: "mutation", input: { title: "", runImmediately: false } })
    .then(() => "accepted").catch((err) => (err as Error).name === "TrpcError" ? "rejected" : "error");
  check("INJ-2 空标题被参数校验拒绝", empty === "rejected", `实际 ${empty}`);
  const longTitle = "长".repeat(600);
  const long = await trpc("threads.dispatch", { token, method: "mutation", input: { title: longTitle, runImmediately: false } })
    .then(() => "accepted").catch(() => "rejected");
  check("INJ-3 超长标题（600>500）被明确拒绝或安全截断", long === "rejected", `实际 ${long}`);

  /* ---------- 越权：租户/工作区 B 凭据读工作区 A 数据 ---------- */
  scene("越权（geo 工作区凭据访问 yunqi 线程数据，应返回空/拒绝而非泄露）");
  const geoToken = await login("geo-growthmatrix", "MEM-GEO1").catch(async () => {
    // 找 geo 工作区任一成员
    const m = await db.query<{ member_no: string }>(
      `SELECT member_no FROM members WHERE workspace_id='ws-geo' LIMIT 1`).catch(() => ({ rows: [] }));
    if (m.rows[0]) return login("geo-growthmatrix", m.rows[0].member_no);
    throw new Error("geo 工作区无可用成员");
  });
  const permissionThread = await trpc<{ threadId: string }>("threads.dispatch", {
    token, method: "mutation", input: { title: `stress·越权探针 ${RUN_ID}`, runImmediately: false },
  });
  createdIds.push(permissionThread.threadId);
  const yunqiThread = await db.query<{ id: string }>(
    `SELECT id FROM threads WHERE id=$1 AND workspace_id='ws-yunqi'`, [permissionThread.threadId]);
  if (yunqiThread.rows[0]) {
    const tid = yunqiThread.rows[0].id;
    const cross = await trpc<unknown>("threads.events", { token: geoToken, input: { threadId: tid } })
      .then((r) => ({ ok: true as const, data: r }))
      .catch((err) => ({ ok: false as const, err: String(err).slice(0, 80) }));
    if (cross.ok) {
      const n = Array.isArray(cross.data) ? cross.data.length : -1;
      check("SEC-1 跨工作区读取 threads.events 应拒绝或返回空", n === 0, `泄露 ${n} 条事件`);
    } else {
      check("SEC-1 跨工作区读取 threads.events 应拒绝或返回空", true, cross.err);
    }
    const crossList = await trpc<Array<{ id: string }>>("threads.list", { token: geoToken });
    const leak = crossList.some((t) => t.id === tid);
    check("SEC-2 跨工作区 threads.list 不得混入他区线程", !leak, `列表 ${crossList.length} 条，泄漏=${leak}`);
  } else {
    throw new Error("越权探针线程未落库，不能以跳过充当通过");
  }
  } finally {
    try {
      if (restoreNumberSource) await db.query(restoreNumberSource);
      if (createdIds.length) await db.query(`DELETE FROM threads WHERE id=ANY($1) AND workspace_id=$2`, [createdIds, SCOPE.workspaceId]);
    } finally { await Promise.all([db.end(), closeAllPools()]); }
  }
  summary();
}

main().catch((err) => { console.error(err); process.exit(2); });
