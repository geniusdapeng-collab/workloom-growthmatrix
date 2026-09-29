/**
 * stress-threads.ts —— 任务派遣链动态排雷（对应静态台账 A-02 / A-03 / A-07 + 边界注入 + 越权）
 * 前置：server 运行中（scheduler 每 7000ms 扫描 queued 线程）。
 * 适用基线：e71f30c。唯一后缀 RUN_ID 保证可复跑。
 */
import { check, login, ownerPool, scene, step, summary, trpc, TrpcError, RUN_ID } from "./_helper.js";

const SCOPE = { tenantId: "tenant-demo", workspaceId: "ws-yunqi" };
const CONCURRENCY_LIMIT = 10; // L3.1：单工作区并发 ≤10

/** 当前占用并发位（与 Router 判定同口径：queued + 有近期心跳的 running） */
async function occupancy(db: { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<{ c: number }> }> }): Promise<number> {
  const r = await db.query(
    `SELECT count(*)::int AS c FROM threads
      WHERE workspace_id=$1
        AND (status='queued' OR (status='running' AND updated_at > now() - interval '10 minutes'))`,
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
  const db = ownerPool();
  const token = await login();
  step(`运行标识 ${RUN_ID}`);

  /* ---------- A-02 ask 线程被调度器当 quest 执行（模拟 runAsk 进行中的 queued ask 线程） ---------- */
  scene("A-02 调度器不得把 ask 问询线程当 Quest 执行");
  const askId = `T-ASK-${RUN_ID}`;
  await db.query(
    `INSERT INTO threads (id, tenant_id, workspace_id, title, status, mode, created_by)
     VALUES ($1,$2,$3,$4,'queued','ask','stress')`,
    [askId, SCOPE.tenantId, SCOPE.workspaceId, `stress·问询线程 ${RUN_ID}`],
  ).catch(async (err) => {
    // 列名兜底：老 schema 可能无 tenant_id/mode/created_by 中的某些列
    step(`完整列插入失败（${String(err).slice(0, 80)}），尝试最小列`);
    await db.query(
      `INSERT INTO threads (id, workspace_id, title, status, mode) VALUES ($1,$2,$3,'queued','ask')`,
      [askId, SCOPE.workspaceId, `stress·问询线程 ${RUN_ID}`],
    );
  });
  step(`已造 queued/mode=ask 线程 ${askId}（模拟 runAsk 执行中状态），等待调度器两轮扫描（16s）…`);
  await new Promise((r) => setTimeout(r, 16_000));
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
  await db.query(`DELETE FROM threads WHERE id=$1`, [askId]);

  /* ---------- A-03/A-07 并发派遣 12 路：全部成功 + 线程号唯一 ---------- */
  scene("A-03/A-07 12 路并发派遣（号源唯一性 / 无重入）");
  const capacityBefore = CONCURRENCY_LIMIT - (await occupancy(db)); // 必须在派遣前测量：派遣后占用已包含本批
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
  const failures = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => classifyFailure(r.reason));
  step(`成功 ${okIds.length}/12，失败 ${failedN}（预算并发位 ${capacityBefore}；${failures.map((f) => `${f.code}:${f.message.slice(0, 40)}`).join(" | ") || "无"}）`);
  /**
   * U-03 之后的上限口径：并发上限判定与建档已串行化——
   *  ① 成功数不得超过提交时的可用并发位；
   *  ② 超限失败必须是业务 429/409，不得 500、不得泄漏 PG 原文；
   *  ③ 派遣后占用不得超过上限（此前 12 路并发实测冲到 13/10）。
   */
  check("A-07 12 路并发派遣：成功数不超过可用并发位", okIds.length <= Math.max(0, capacityBefore), `成功 ${okIds.length}，预算 ${capacityBefore}`);
  check("A-07c 超限失败为业务错误（不得 500 / 泄漏 PG 原文）",
    failures.every((f) => (f.code === "TOO_MANY_REQUESTS" || f.code === "CONFLICT") && !f.leak),
    failures.map((f) => `${f.code}${f.leak ? "(泄漏)" : ""}`).join(",") || "无失败");
  const afterBurst = await occupancy(db);
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
         AS $$ SELECT ${floor}::bigint $$`);
      injected = true;
      const hitTitle = `${u03Prefix}·撞号单 ${Date.now().toString(36)}`;
      await trpc("threads.dispatch", { token, method: "mutation", input: { title: hitTitle, runImmediately: false } })
        .then(() => step("撞号首单：建档成功（占用恒定号）"))
        .catch((err) => step(`撞号首单异常：${classifyFailure(err).code}`));
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
      if (injected) await db.query(originalFn);
    }
    const restored = (await db.query<{ ok: boolean }>(
      `SELECT position('nextval' in pg_get_functiondef('public.threads_max_t_no()'::regprocedure)) > 0 AS ok`)).rows[0]?.ok === true;
    check("U-03f 故障注入后号源函数必须还原（含 nextval）", restored, restored ? "" : "函数未还原，需人工检查");
  }
  // 清掉撞号注入造的线程，把并发位还给下面的"打满→冲击"用例
  await db.query(`DELETE FROM threads WHERE workspace_id=$1 AND title LIKE $2`, [SCOPE.workspaceId, `${u03Prefix}·撞号单%`]);

  // ② 并发上限竞争：先填满并发位，再并发冲击——占用不得超限，拒绝必须是业务码
  let fillOk = 0;
  while ((await occupancy(db)) < CONCURRENCY_LIMIT && fillOk < CONCURRENCY_LIMIT + 2) {
    try {
      await trpc("threads.dispatch", {
        token, method: "mutation", input: { title: `${u03Prefix}·填充 ${fillOk}`, runImmediately: false },
      });
      fillOk += 1;
    } catch (err) {
      const f = classifyFailure(err);
      step(`填充中断（${f.code}）：${f.message.slice(0, 60)}`);
      break;
    }
  }
  step(`已填充 ${fillOk} 条，占用 ${await occupancy(db)}/${CONCURRENCY_LIMIT}`);
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
  const yunqiThread = await db.query<{ id: string }>(
    `SELECT id FROM threads WHERE workspace_id='ws-yunqi' LIMIT 1`);
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
    step("ws-yunqi 无线程可测，跳过 SEC-1/2");
  }

  await db.end();
  summary();
}

main().catch((err) => { console.error(err); process.exit(2); });
