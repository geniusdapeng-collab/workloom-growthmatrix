/** Real PostgreSQL, app-role RLS and transaction contracts. Fixtures are unique and retained. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { gatewayAppendOnClient } from "@workloom/base/workdata";
import { closeAllPools } from "@workloom/db";
import type { Identity } from "@workloom/base/tenancy";
import { AgentInvocationLedger, agentCanonicalJson, agentInputHash, linkAgentInvocation, lockAgentInvocation,
  type AgentInvocation, type AgentInvocationRef } from "./invocations.js";
import { insertQueuedThread } from "../runtime/thread-admission.js";
import { buildAgentRouter } from "../trpc/agent-router.js";
import type { TrpcContext } from "../trpc/context.js";
import { FilmLedger } from "../video/film-ledger.js";

const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL) && Boolean(process.env.DATABASE_APP_URL);
describe.runIf(RUN_DB)("持久 Agent 调用：真实 PostgreSQL 并发、作用域、绑定与取消", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 3000 });
  const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL, max: 16, connectionTimeoutMillis: 3000 });
  const run = randomUUID();
  const scope = { tenantId: `t-agent-${run}`, workspaceId: `w-agent-${run}`, memberNo: "MEM-001" };
  const ledger = new AgentInvocationLedger(app, scope);
  const otherMember = new AgentInvocationLedger(app, { ...scope, memberNo: "MEM-002" });
  const otherWorkspace = new AgentInvocationLedger(app, { ...scope, workspaceId: `w-agent-other-${run}` });
  const otherTenant = new AgentInvocationLedger(app, { ...scope, tenantId: `t-agent-other-${run}`, workspaceId: `w-agent-tenant-${run}` });
  const hash = agentInputHash("task.dispatch", { title: "真实事务夹具" });
  const identity: Identity = { kind: "member", memberId: `m-agent-${run}`, memberNo: scope.memberNo, name: "调用夹具成员",
    role: "owner", tenantId: scope.tenantId, workspaceId: scope.workspaceId, plan: "pro" };
  const context: TrpcContext = { session: identity, identity, partnerIdentity: null, headers: new Headers() };
  let calls = 0;

  beforeAll(async () => {
    const schema = await owner.query("SELECT to_regclass('agent_invocations') AS table_name");
    expect(schema.rows[0]?.table_name, "Run actual migration first; this contract must not silently skip missing schema").toBe("agent_invocations");
    for (const tenantId of [scope.tenantId, otherTenant.scope.tenantId]) {
      await owner.query("INSERT INTO tenants (id,name,plan) VALUES ($1,'Agent 调用隔离夹具','pro')", [tenantId]);
    }
    for (const own of [scope, otherWorkspace.scope, otherTenant.scope]) {
      await owner.query("INSERT INTO workspaces (id,tenant_id,name,slug,industry) VALUES ($1,$2,'Agent 调用隔离夹具',$1,'general')", [own.workspaceId, own.tenantId]);
      for (const memberNo of ["MEM-001", "MEM-002"]) {
        const memberId = own.workspaceId === scope.workspaceId && memberNo === scope.memberNo ? identity.memberId : randomUUID();
        await owner.query("INSERT INTO members (id,workspace_id,member_no,name,role) VALUES ($1,$2,$3,'调用夹具成员','owner')", [memberId, own.workspaceId, memberNo]);
      }
      await owner.query("INSERT INTO profiles (workspace_id,tenant_id,industry,archive) VALUES ($1,$2,'general',$3::jsonb)",
        [own.workspaceId, own.tenantId, JSON.stringify({ dataMode: "simulated" })]);
    }
    await owner.query("INSERT INTO agents (id,workspace_id,preset_key,name,version,kind,readonly,status) VALUES ($1,$2,'sandbox-ready','沙箱岗位','1','assistant',false,'ready'),($3,$2,'sandbox-disabled','停用岗位','1','assistant',true,'disabled')",
      [randomUUID(), scope.workspaceId, randomUUID()]);
  });
  afterAll(async () => { await Promise.all([owner.end(), app.end(), closeAllPools()]); });

  const ref = (row: AgentInvocation): AgentInvocationRef => ({ id: row.id, ownerToken: row.owner_token,
    memberNo: row.member_no, action: row.action as AgentInvocationRef["action"] });
  const claim = (meta = {}) => ledger.claim("task.dispatch", `case-${randomUUID()}`, hash, meta);
  async function bindTask(row: AgentInvocation, mode = "quest", throwAfterLink = false): Promise<string> {
    return ledger.transaction(async (client) => {
      await lockAgentInvocation(client, scope, ref(row));
      await client.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [scope.workspaceId]);
      const threadId = await insertQueuedThread(client, { ...scope, title: `Agent 事务 ${run}`, mode,
        createdBy: scope.memberNo, agentId: null });
      const event = await gatewayAppendOnClient(client, { ...scope, actor: { id: scope.memberNo, type: "human" }, sessionId: threadId }, {
        who: { type: "human", id: scope.memberNo },
        context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
        object: { type: "thread", id: threadId }, decision: { action: "thread.dispatch", after: { threadId } }, rule_impact: [],
      });
      await linkAgentInvocation(client, ref(row), "thread", threadId, event.eventId);
      if (throwAfterLink) throw new Error("rollback-all-three");
      return threadId;
    });
  }
  const router = buildAgentRouter({ dispatch: async (ctx, input) => {
    calls += 1;
    expect(ctx.agentInvocation?.memberNo).toBe(scope.memberNo);
    const own = await ledger.read(ctx.agentInvocation!.id);
    if (input.title === "澄清目标") return { kind: "clarify", question: "请提供具体的交付目标" };
    if (input.title === "模拟未知异常") throw new Error("unknown-after-request");
    const threadId = await bindTask(own);
    if (input.title === "建档后抛错") throw new Error("after-link-error");
    return { kind: "dispatched", threadId, mode: "quest" };
  } });

  it("Unicode 与字段顺序具有同一输入摘要，参数或动作变化具有不同摘要", () => {
    expect(agentCanonicalJson({ b: "🚀 中文", a: [1, { z: true, y: null }] })).toBe(agentCanonicalJson({ a: [1, { y: null, z: true }], b: "🚀 中文" }));
    expect(agentInputHash("task.dispatch", { a: 1, b: "中文" })).toBe(agentInputHash("task.dispatch", { b: "中文", a: 1 }));
    expect(agentInputHash("task.dispatch", {})).not.toBe(agentInputHash("task.cancel", {}));
  });
  it("12 路同键并发只有一位 owner；重复请求不再授予执行所有权", async () => {
    const key = `parallel-${randomUUID()}`;
    const rows = await Promise.all(Array.from({ length: 12 }, () => ledger.claim("task.dispatch", key, hash)));
    expect(rows.filter(item => item.owner)).toHaveLength(1);
    expect(new Set(rows.map(item => item.row.id)).size).toBe(1);
    expect((await ledger.claim("task.dispatch", key, hash)).owner).toBe(false);
  });
  it("同键异参或异动作报 CONFLICT，原始摘要保持不变", async () => {
    const key = `conflict-${randomUUID()}`;
    const first = await ledger.claim("task.dispatch", key, hash);
    await expect(ledger.claim("task.dispatch", key, agentInputHash("task.dispatch", "changed"))).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(ledger.claim("task.cancel", key, hash)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await ledger.read(first.row.id)).input_sha256).toBe(hash);
  });
  it("租户、工作区与成员均隔离；同键在不同 scope 分别拥有自己的调用", async () => {
    const key = `scope-${randomUUID()}`;
    const first = await ledger.claim("task.dispatch", key, hash);
    for (const other of [otherMember, otherWorkspace, otherTenant]) {
      await expect(other.read(first.row.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      const own = await other.claim("task.dispatch", key, hash);
      expect(own.owner).toBe(true);
      expect(own.row.id).not.toBe(first.row.id);
    }
    const unscoped = await app.query("SELECT id FROM agent_invocations WHERE id=$1", [first.row.id]);
    expect(unscoped.rows).toHaveLength(0);
    await expect(otherMember.transaction(client => client.query("UPDATE agent_invocations SET member_no=$2 WHERE id=$1", [first.row.id, "MEM-002"])))
      .resolves.toMatchObject({ rowCount: 0 });
  });
  it("创建事务核对随机所有权和动作，不接受错误 member 或 owner", async () => {
    const first = await claim();
    for (const wrong of [{ ...ref(first.row), ownerToken: randomUUID() }, { ...ref(first.row), memberNo: "MEM-002" },
      { ...ref(first.row), action: "film.start" as const }]) {
      await expect(ledger.transaction(client => lockAgentInvocation(client, scope, wrong))).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    }
    expect((await ledger.read(first.row.id)).state).toBe("reserved");
  });
  it("线程、事件与调用绑定同事务；抛错后三者一起回滚", async () => {
    const first = await claim();
    const before = await owner.query("SELECT (SELECT count(*) FROM threads WHERE workspace_id=$1) AS threads,(SELECT count(*) FROM biz_events WHERE workspace_id=$1) AS events", [scope.workspaceId]);
    await expect(bindTask(first.row, "quest", true)).rejects.toThrow("rollback-all-three");
    expect((await ledger.read(first.row.id)).state).toBe("reserved");
    const after = await owner.query("SELECT (SELECT count(*) FROM threads WHERE workspace_id=$1) AS threads,(SELECT count(*) FROM biz_events WHERE workspace_id=$1) AS events", [scope.workspaceId]);
    expect(after.rows).toEqual(before.rows);
  });
  it("建档后异常不丢实体、不重新派单；终态响应只能写一次", async () => {
    const first = await claim();
    const threadId = await bindTask(first.row);
    await ledger.finish(first.row, { code: "unknown" }, { code: "EXECUTION_UNKNOWN", uncertain: true });
    expect(await ledger.read(first.row.id)).toMatchObject({ state: "linked", entity_id: threadId, failure_code: null });
    await ledger.finish(first.row, { replacement: true });
    expect((await ledger.read(first.row.id)).result).toEqual({ code: "unknown" });
    await expect(ledger.transaction(client => client.query("UPDATE agent_invocations SET entity_id='other' WHERE id=$1", [first.row.id])))
      .rejects.toThrow("cannot be rebound");
  });
  it("unknown 调用在新 ledger 实例中仍不执行；失败、摘要和响应不可覆盖或删除", async () => {
    const key = `unknown-${randomUUID()}`;
    const first = await ledger.claim("task.dispatch", key, hash);
    await ledger.finish(first.row, { code: "UNKNOWN" }, { code: "EXECUTION_UNKNOWN", uncertain: true });
    const restarted = new AgentInvocationLedger(app, scope);
    expect(await restarted.claim("task.dispatch", key, hash)).toMatchObject({ owner: false, row: { state: "unknown", failure_code: "EXECUTION_UNKNOWN" } });
    for (const sql of ["UPDATE agent_invocations SET state='reserved' WHERE id=$1", "UPDATE agent_invocations SET input_sha256=repeat('a',64) WHERE id=$1",
      "UPDATE agent_invocations SET result='{}'::jsonb WHERE id=$1"]) {
      await expect(ledger.transaction(client => client.query(sql, [first.row.id]))).rejects.toThrow();
    }
    await expect(owner.query("DELETE FROM agent_invocations WHERE id=$1", [first.row.id])).rejects.toThrow("cannot be deleted");
  });
  it("创建前取消使后来的创建锁失败；取消结果与网关事件同事务", async () => {
    const target = await claim();
    const cancellation = await ledger.claim("task.cancel", `cancel-${randomUUID()}`, agentInputHash("task.cancel", target.row.id));
    expect(await ledger.cancel(cancellation.row, target.row.id)).toMatchObject({ state: "cancelled", cancelledBeforeCreation: true, rollbackExternalActions: false });
    await expect(bindTask(target.row)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const stored = await ledger.read(cancellation.row.id);
    expect(stored).toMatchObject({ state: "resolved", event_id: expect.any(String) });
    const events = await owner.query("SELECT payload FROM biz_events WHERE event_id=$1 AND tenant_id=$2", [stored.event_id, scope.tenantId]);
    expect(events.rows[0]?.payload.decision.action).toBe("thread.cancel");
  });
  it.each(["queued", "running", "pending_review", "paused"])("已绑定普通任务 %s 能取消并保留实体", async status => {
    const target = await claim();
    const threadId = await bindTask(target.row);
    await owner.query("UPDATE threads SET status=$2 WHERE id=$1", [threadId, status]);
    const cancellation = await ledger.claim("task.cancel", `cancel-${randomUUID()}`, hash);
    expect(await ledger.cancel(cancellation.row, target.row.id)).toMatchObject({ state: "cancelled", threadId, alreadyTerminal: false });
    expect((await ledger.read(target.row.id)).entity_id).toBe(threadId);
    expect((await owner.query("SELECT status FROM threads WHERE id=$1", [threadId])).rows[0]?.status).toBe("cancelled");
  });
  it.each(["completed", "failed", "cancelled"])("原任务终态 %s 不被取消覆盖", async status => {
    const target = await claim();
    const threadId = await bindTask(target.row);
    await owner.query("UPDATE threads SET status=$2 WHERE id=$1", [threadId, status]);
    const cancellation = await ledger.claim("task.cancel", `cancel-${randomUUID()}`, hash);
    expect(await ledger.cancel(cancellation.row, target.row.id)).toMatchObject({ state: status, alreadyTerminal: true });
    expect((await owner.query("SELECT status FROM threads WHERE id=$1", [threadId])).rows[0]?.status).toBe(status);
  });
  it("ASK 与不可可靠停止的影片任务拒绝取消；不存在及跨成员也不留取消假成功", async () => {
    const ask = await claim();
    const threadId = await bindTask(ask.row, "ask");
    const video = await claim({ cancellable: false });
    for (const targetId of [ask.row.id, video.row.id]) {
      const cancellation = await ledger.claim("task.cancel", `cancel-${randomUUID()}`, hash);
      await expect(ledger.cancel(cancellation.row, targetId)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      expect((await ledger.read(cancellation.row.id)).state).toBe("reserved");
    }
    const cross = await otherMember.claim("task.cancel", `cancel-${randomUUID()}`, hash);
    await expect(otherMember.cancel(cross.row, ask.row.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await owner.query("SELECT status FROM threads WHERE id=$1", [threadId])).rows[0]?.status).toBe("queued");
  });
  it("真实路由 8 路并发仅调用一次执行器，回执保持 pending 与模拟，停用后原键仍可重读", async () => {
    const before = calls;
    const input = { title: "真实并发派单", presetKey: "sandbox-ready", runImmediately: false, idempotencyKey: `api-${randomUUID()}` };
    const rows = await Promise.all(Array.from({ length: 8 }, () => router.createCaller(context).taskDispatch(input)));
    expect(calls - before).toBe(1);
    expect(new Set(rows.map(item => item.result.invocationId)).size).toBe(1);
    expect(rows.every(item => item.status === "pending" && item.dataMode === "simulated" && item.receipt.businessVerified === false)).toBe(true);
    await owner.query("UPDATE agents SET status='disabled' WHERE workspace_id=$1 AND preset_key='sandbox-ready'", [scope.workspaceId]);
    try {
      const replay = await router.createCaller(context).taskDispatch(input);
      expect(rows).toHaveLength(8);
      expect(replay.result.invocationId).toBe(rows[0]!.result.invocationId);
      expect(calls - before).toBe(1);
    } finally { await owner.query("UPDATE agents SET status='ready' WHERE workspace_id=$1 AND preset_key='sandbox-ready'", [scope.workspaceId]); }
  });
  it("不存在/停用岗位明确失败，不调用执行器，也不回落默认岗位", async () => {
    const before = calls;
    for (const [presetKey, failureCode] of [["nonexistent", "NOT_FOUND"], ["sandbox-disabled", "PRECONDITION_FAILED"]]) {
      const result = await router.createCaller(context).taskDispatch({ title: "指定岗位", presetKey, runImmediately: false, idempotencyKey: `api-${randomUUID()}` });
      expect(result).toMatchObject({ status: "failed", result: { failureCode, state: "failed" }, receipt: { synced: false } });
    }
    expect(calls).toBe(before);
  });
  it("澄清回执不冒充完成；未知异常不重发；建档后抛错保留原线程", async () => {
    for (const title of ["澄清目标", "模拟未知异常", "建档后抛错"]) {
      const before = calls;
      const input = { title, runImmediately: false, idempotencyKey: `api-${randomUUID()}` };
      const first = await router.createCaller(context).taskDispatch(input);
      const replay = await router.createCaller(context).taskDispatch(input);
      expect(calls - before).toBe(1);
      expect(replay.result.invocationId).toBe(first.result.invocationId);
      expect(first.status).toBe("pending");
      if (title === "澄清目标") expect(first.result).toMatchObject({ state: "resolved", needsInput: true });
      if (title === "模拟未知异常") expect(first.result).toMatchObject({ state: "unknown", requiresReconciliation: true });
      if (title === "建档后抛错") expect(first.result).toMatchObject({ state: "linked", thread: { id: expect.any(String) } });
    }
  });
  it("影片作业与 Agent 调用在认领事务内绑定，重复 owner 不能再建作业", async () => {
    const films = new FilmLedger(app, scope);
    const worker = await films.registerWorker({ workerName: "full-chain-film", workerVersion: "test", entryPath: "scripts/tools/full-chain-film.mts",
      entrySha256: hash, capabilities: ["review"], actor: scope.memberNo });
    const projectId = `P-agent-${run}`;
    await owner.query("INSERT INTO video_projects (id,workspace_id,title,kind,created_by) VALUES ($1,$2,'Agent 工位事务','narrative',$3)", [projectId, scope.workspaceId, scope.memberNo]);
    const own = await ledger.claim("film.start", `film-${randomUUID()}`, agentInputHash("film.start", { projectId }));
    const input = { projectId, workerId: worker.id, runId: `run-${run}`, stages: ["spec"], options: {}, budgetCny: 0,
      inputRef: "stages/film/inputs/fixture.json", inputSha256: hash, workerEntrySha256: hash, actor: scope.memberNo, agentInvocation: ref(own.row) };
    const job = await films.claimJob(input);
    expect(await ledger.read(own.row.id)).toMatchObject({ state: "linked", entity_kind: "film", entity_id: job.id, event_id: expect.any(String) });
    await expect(films.claimJob(input)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((await owner.query("SELECT id FROM film_jobs WHERE project_id=$1", [projectId])).rows).toHaveLength(1);
    await films.finishJob(job.id, { status: "failed", errorClass: "TEST_COMPLETE", errorMsg: "测试闭合" });
  });

  it("创建持有调用行锁时，取消等待实际锁释放后停止唯一新线程", async () => {
    const target = await claim();
    const cancellation = await ledger.claim("task.cancel", `cancel-race-${randomUUID()}`, hash);
    let releaseCreation!: () => void;
    let announceLock!: () => void;
    const release = new Promise<void>(resolve => { releaseCreation = resolve; });
    const locked = new Promise<void>(resolve => { announceLock = resolve; });
    let creationPid = 0;
    const creation = ledger.transaction(async client => {
      await lockAgentInvocation(client, scope, ref(target.row));
      creationPid = Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid);
      announceLock();
      await release;
      const threadId = await insertQueuedThread(client, { ...scope, title: `真实取消竞争 ${run}`, mode: "quest", createdBy: scope.memberNo, agentId: null });
      const event = await gatewayAppendOnClient(client, { ...scope, actor: { id: scope.memberNo, type: "human" }, sessionId: threadId }, {
        who: { type: "human", id: scope.memberNo },
        context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
        object: { type: "thread", id: threadId }, decision: { action: "thread.dispatch", after: { threadId } }, rule_impact: [],
      });
      await linkAgentInvocation(client, ref(target.row), "thread", threadId, event.eventId);
      return threadId;
    });
    await locked;
    const cancelled = ledger.cancel(cancellation.row, target.row.id);
    let waitObserved = false;
    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const blocked = await owner.query("SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [creationPid]);
        if (blocked.rowCount) { waitObserved = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waitObserved, "The cancellation must actually wait on the creation transaction").toBe(true);
    } finally { releaseCreation(); }
    const threadId = await creation;
    expect(await cancelled).toMatchObject({ threadId, state: "cancelled", alreadyTerminal: false });
    expect(await ledger.read(target.row.id)).toMatchObject({ entity_id: threadId, state: "cancelled" });
    expect((await owner.query("SELECT status FROM threads WHERE id=$1", [threadId])).rows).toEqual([{ status: "cancelled" }]);
    await expect(bindTask(target.row)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it.each(["action", "session", "object", "member"])("错误 %s 的已有事件不能绑定为派单回执，实体与事件一起回滚", async mismatch => {
    const target = await claim();
    const before = await owner.query("SELECT (SELECT count(*) FROM threads WHERE workspace_id=$1) AS threads,(SELECT count(*) FROM biz_events WHERE workspace_id=$1) AS events", [scope.workspaceId]);
    await expect(ledger.transaction(async client => {
      await lockAgentInvocation(client, scope, ref(target.row));
      const threadId = await insertQueuedThread(client, { ...scope, title: `错误绑定 ${mismatch}`, mode: "quest", createdBy: scope.memberNo, agentId: null });
      const memberNo = mismatch === "member" ? "MEM-002" : scope.memberNo;
      const event = await gatewayAppendOnClient(client, { ...scope, actor: { id: memberNo, type: "human" }, sessionId: mismatch === "session" ? "other-session" : threadId }, {
        who: { type: "human", id: memberNo },
        context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
        object: { type: "thread", id: mismatch === "object" ? "other-thread" : threadId },
        decision: { action: mismatch === "action" ? "task.fixture" : "thread.dispatch", after: { threadId } }, rule_impact: [],
      });
      await linkAgentInvocation(client, ref(target.row), "thread", threadId, event.eventId);
    })).rejects.toThrow("requires an in-scope dispatch event");
    expect((await ledger.read(target.row.id)).state).toBe("reserved");
    expect((await owner.query("SELECT (SELECT count(*) FROM threads WHERE workspace_id=$1) AS threads,(SELECT count(*) FROM biz_events WHERE workspace_id=$1) AS events", [scope.workspaceId])).rows).toEqual(before.rows);
  });
});
