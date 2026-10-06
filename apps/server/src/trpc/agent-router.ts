/** Reviewed CLI/MCP operations reuse existing business executors and their authorization. */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { getAppPool } from "@workloom/db";
import { FILM_CLI_STAGES, normalizeFilmJobRequest } from "@hyperreality/video-studio";
import { AgentInvocationLedger, agentInputHash, type AgentInvocation, type AgentInvocationRef, type AgentScope } from "../agent/invocations.js";
import { agentArtifactData, artifactsFromEvents, filmArtifacts, inspectAgentArtifacts, taskArtifactRoots } from "../agent/artifacts.js";
import { FilmLedger } from "../video/film-ledger.js";
import { filmRouter } from "../video/film-router.js";
import { capabilityActionProcedure, protectedProcedure, router, type TrpcContext } from "./context.js";
import { memberAccessGrants } from "../service/access-authority.js";

const id = z.string().uuid();
const key = z.string().min(8).max(200).refine((value) => value.trim().length >= 8 && !/[\0\r\n]/.test(value), "请求键不能只有空白或包含控制字符");
const preset = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const taskDispatchInput = z.object({
  title: z.string().trim().min(1).max(120), presetKey: preset.optional(), goalRef: z.string().min(1).max(120).optional(),
  runImmediately: z.boolean().default(false), idempotencyKey: key,
}).strict();
export type AgentTaskInput = z.infer<typeof taskDispatchInput>;
export const filmStartInput = z.object({
  projectId: z.string().max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).refine((value) => !value.includes("..")),
  document: z.record(z.string(), z.unknown()),
  stages: z.array(z.enum(FILM_CLI_STAGES)).min(1).max(FILM_CLI_STAGES.length),
  options: z.record(z.string(), z.union([z.string().max(5000), z.number().finite(), z.boolean()])).default({}),
  maxBudgetCny: z.number().positive().max(100_000).optional(), idempotencyKey: key,
}).strict().superRefine((value, ctx) => {
  if (Buffer.byteLength(JSON.stringify(value.document)) > 4 * 1024 * 1024) {
    ctx.addIssue({ code: "custom", path: ["document"], message: "原稿超过 4 MiB" });
  }
  if (Object.keys(value.options).length > 40) ctx.addIssue({ code: "custom", path: ["options"], message: "选项数量超限" });
});
const invocationInput = z.object({ invocationId: id }).strict();
const artifactInput = invocationInput.extend({ index: z.number().int().min(0).max(999) }).strict();
const videoGoal = /视频|短片|影片|成片|镜头卡|分镜|宣传片|TVC|纪录片|口播|种草片|混剪/;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const agentWriteProcedure = capabilityActionProcedure("quest", "task.dispatch").use(({ ctx, next }) => {
  const grants = memberAccessGrants({ role: ctx.identity.role, plan: ctx.identity.plan,
    guest: ctx.identity.memberNo === "GUEST", permissions: ctx.memberPermissions });
  if (!grants.actionPermissions.includes("workspace.write")) throw new TRPCError({ code: "FORBIDDEN", message: "当前成员没有工作区内容修改权限" });
  return next();
});

function scopeFor(ctx: TrpcContext): AgentScope {
  if (!ctx.identity) throw new TRPCError({ code: "UNAUTHORIZED", message: "缺少成员身份" });
  return { tenantId: ctx.identity.tenantId, workspaceId: ctx.identity.workspaceId, memberNo: ctx.identity.memberNo };
}
const ledgerFor = (ctx: TrpcContext): AgentInvocationLedger => new AgentInvocationLedger(getAppPool(), scopeFor(ctx));
function publicInvocation(row: AgentInvocation, replayed: boolean) {
  return { invocationId: row.id, action: row.action, state: row.state, inputSha256: row.input_sha256,
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(), replayed,
    requiresReconciliation: row.state === "unknown", failureCode: row.failure_code };
}
function safeResponse(value: unknown): Record<string, unknown> {
  const input = record(value);
  const result: Record<string, unknown> = {};
  for (const name of ["kind", "mode", "via", "question", "answer", "status", "error", "presetKey", "code"]) {
    if (typeof input[name] === "string") result[name] = String(input[name]).slice(0, name === "answer" ? 8000 : 500);
  }
  for (const name of ["unverified", "warnings"]) {
    if (Array.isArray(input[name])) result[name] = input[name].filter((item: unknown) => typeof item === "string").slice(0, 100);
  }
  return result;
}

export function agentDataMode(profileMode: unknown, events: unknown[] = [], env: NodeJS.ProcessEnv = process.env): "simulated" | "provided-unverified" | "unverified" {
  // Even real connector receipts need a separate business assertion. Model/profile names are not that assertion.
  return env.LLM_PROVIDER === "mock" || profileMode === "simulated" || events.some((event) => record(record(event).receipt).mode === "simulated")
    ? "simulated" : profileMode === "real" ? "provided-unverified" : "unverified";
}
function envelope(capabilityId: string, operation: "execute" | "receipt", status: "succeeded" | "pending" | "failed", dataMode: string,
  result: Record<string, unknown>, receipt: Record<string, unknown> = {}) {
  return { schemaVersion: "workloom.capability-result/v1", capabilityId, operation, status, dataMode, result,
    receipt: { synced: false, sourceVerified: false, businessVerified: false, ...receipt } };
}
async function profileMode(ledger: AgentInvocationLedger): Promise<unknown> {
  return ledger.transaction(async (client) => {
    const profiles = await client.query("SELECT archive->>'dataMode' AS mode FROM profiles WHERE workspace_id=$1 AND tenant_id=$2",
      [ledger.scope.workspaceId, ledger.scope.tenantId]);
    return profiles.rows[0]?.mode ?? "unverified";
  });
}

async function readyPreset(ledger: AgentInvocationLedger, presetKey?: string): Promise<void> {
  if (!presetKey) return;
  await ledger.transaction(async (client) => {
    const agents = await client.query("SELECT status FROM agents WHERE workspace_id=$1 AND preset_key=$2", [ledger.scope.workspaceId, presetKey]);
    if (!agents.rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "指定岗位不存在于当前工作区" });
    if (agents.rows[0].status !== "ready") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "指定岗位尚未就绪或已停用" });
  });
}

async function taskData(ledger: AgentInvocationLedger, row: AgentInvocation) {
  if (row.action !== "task.dispatch" || row.entity_kind !== "thread" || !row.entity_id) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "调用尚未绑定任务实体" });
  }
  return ledger.transaction(async (client) => {
    const threads = await client.query(
      `SELECT t.id,t.title,t.mode,t.status,t.progress_done,t.progress_total,t.error,t.created_at,t.updated_at,t.closed_at,
         a.preset_key,a.name AS agent_name,a.readonly,a.status AS agent_status,a.meta->'tools' AS tools
       FROM threads t LEFT JOIN agents a ON a.id=t.agent_id AND a.workspace_id=t.workspace_id
       WHERE t.id=$1 AND t.tenant_id=$2 AND t.workspace_id=$3 AND t.created_by=$4`,
      [row.entity_id, ledger.scope.tenantId, ledger.scope.workspaceId, ledger.scope.memberNo]);
    if (!threads.rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "已绑定任务没有本人成员的实体回执" });
    const rows = await client.query<{ event_id: string; payload: unknown }>(
      `SELECT event_id,payload FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 AND session_id=$3 ORDER BY seq ASC LIMIT 501`,
      [ledger.scope.tenantId, ledger.scope.workspaceId, row.entity_id]);
    const events = rows.rows.slice(0, 500);
    return { thread: threads.rows[0], events, truncated: rows.rows.length > 500 };
  });
}

async function taskReceipt(ledger: AgentInvocationLedger, row: AgentInvocation, capabilityId: string, operation: "execute" | "receipt", replayed = false) {
  if (row.action !== "task.dispatch") throw new TRPCError({ code: "BAD_REQUEST", message: "该调用不是任务派单" });
  const mode = await profileMode(ledger);
  if (!row.entity_id) {
    return envelope(capabilityId, operation, ["failed", "cancelled"].includes(row.state) ? "failed" : "pending", agentDataMode(mode),
      { ...publicInvocation(row, replayed), response: safeResponse(row.result), needsInput: row.result?.kind === "clarify" });
  }
  const data = await taskData(ledger, row);
  const payloads = data.events.map((event) => event.payload);
  const items = artifactsFromEvents(payloads);
  const artifacts = await inspectAgentArtifacts(items, taskArtifactRoots(ledger.scope.workspaceId));
  const answerEvent = [...payloads].reverse().find((event) => record(record(event).decision).action === "ask.answer");
  const answer = record(record(record(answerEvent).decision).after).text;
  const steps = new Map<string, { synced: boolean; mode: unknown }>();
  for (const raw of payloads) {
    const event = record(raw);
    const decision = record(event.decision);
    if (typeof decision.step_id === "string" && decision.kind !== "execution_started") {
      steps.set(decision.step_id, { synced: record(event.receipt).synced === true, mode: record(event.receipt).mode });
    }
  }
  const completed = data.thread.status === "completed";
  const hasAnswer = typeof answer === "string" && answer.length > 0;
  const verifiedSteps = [...steps.values()].filter((step) => step.synced).length;
  const hasDelivery = hasAnswer || verifiedSteps > 0 || artifacts.some((artifact) => artifact.byteVerified);
  const artifactFailure = artifacts.some((artifact) => !artifact.byteVerified);
  const dataMode = agentDataMode(mode, payloads);
  const status = ["failed", "cancelled"].includes(data.thread.status) || artifactFailure || completed && !hasDelivery ? "failed"
    : completed && !data.truncated ? "succeeded" : "pending";
  const boundEvent = data.events.some((event) => event.event_id === row.event_id);
  return envelope(capabilityId, operation, status, dataMode, {
    ...publicInvocation(row, replayed), thread: { id: data.thread.id, title: data.thread.title, mode: data.thread.mode, status: data.thread.status,
      stepsDone: data.thread.progress_done, stepsTotal: data.thread.progress_total,
      error: typeof data.thread.error === "string" ? data.thread.error.slice(0, 500) : null },
    employee: { presetKey: data.thread.preset_key, name: data.thread.agent_name, readonly: data.thread.readonly === true,
      status: data.thread.agent_status, tools: Array.isArray(data.thread.tools) ? data.thread.tools.map((tool: unknown) => record(tool).name).filter((name: unknown) => typeof name === "string") : [] },
    delivery: { kind: hasAnswer ? "read-only-answer" : artifacts.length ? dataMode === "simulated" ? "sandbox-artifact" : "artifact"
      : verifiedSteps ? data.thread.readonly ? "read-only-receipt" : "action-receipt" : completed ? "capability-gap" : "awaiting-execution",
      ...(hasAnswer ? { answer } : {}), verifiedSteps, capabilityGap: completed && !hasDelivery },
    response: safeResponse(row.result), artifacts, eventHistoryTruncated: data.truncated,
    events: data.events.map(({ event_id, payload }) => {
      const event = record(payload); const decision = record(event.decision);
      return { eventId: event_id, action: decision.action, stepId: decision.step_id, kind: decision.kind,
        actor: record(event.who).id, receiptSynced: record(event.receipt).synced === true, receiptMode: record(event.receipt).mode };
    }),
    execution: { profileDataMode: mode, modelProvider: process.env.LLM_PROVIDER ?? "unverified", paidProviderVerified: false,
      rollbackExternalActions: false, businessClaims: "沙箱、只读与工具回执须分别核对；不代表真实发布、达人台账写入或成本归集" },
  }, { eventId: row.event_id, synced: completed && hasDelivery && !artifactFailure && boundEvent && !data.truncated,
    sourceVerified: boundEvent && !artifactFailure && !data.truncated && artifacts.every(artifact => artifact.sourceVerified) });
}

async function filmReceipt(ledger: AgentInvocationLedger, row: AgentInvocation, capabilityId: string, operation: "execute" | "receipt", replayed = false) {
  if (row.action !== "film.start") throw new TRPCError({ code: "BAD_REQUEST", message: "该调用不是影片工位" });
  const mode = await profileMode(ledger);
  if (!row.entity_id || row.entity_kind !== "film") {
    return envelope(capabilityId, operation, row.state === "failed" ? "failed" : "pending", agentDataMode(mode),
      { ...publicInvocation(row, replayed), response: safeResponse(row.result) });
  }
  const films = new FilmLedger(getAppPool(), ledger.scope);
  const job = await films.readJob(row.entity_id);
  if (!job || job.created_by !== ledger.scope.memberNo) throw new TRPCError({ code: "NOT_FOUND", message: "影片作业没有本人成员的实体回执" });
  const status = await films.jobStatus(job.id);
  if (!status) throw new TRPCError({ code: "NOT_FOUND", message: "影片作业状态缺失" });
  let artifacts: Awaited<ReturnType<typeof inspectAgentArtifacts>> = [];
  let artifactError: string | null = null;
  try {
    const files = await filmArtifacts(job);
    artifacts = await inspectAgentArtifacts(files.items, files.roots);
  } catch (error) {
    if (!(error instanceof TRPCError)) throw error;
    artifactError = error.code;
  }
  const verified = job.status === "finished" && !artifactError && artifacts.length > 0 && artifacts.every((item) => item.sourceVerified);
  const state = ["failed", "interrupted"].includes(job.status) || job.status === "finished" && !verified ? "failed" : verified ? "succeeded" : "pending";
  return envelope(capabilityId, operation, state, agentDataMode(mode), {
    ...publicInvocation(row, replayed), job: { jobId: status.jobId, projectId: status.projectId, attempt: status.attempt, runId: status.runId,
      workerName: status.workerName, status: status.status, stages: status.stages, startedAt: status.startedAt, finishedAt: status.finishedAt,
      errorClass: status.errorClass, errorMessage: status.errorMessage, resultSha256: status.resultSha256,
      components: status.components, reservedCny: status.reservedCny, spentCny: status.spentCny },
    artifacts, artifactError, execution: { profileDataMode: mode, modelProvider: process.env.LLM_PROVIDER ?? "unverified",
      paidProviderVerified: false, businessClaims: "阶段与文件回执可核对；确定性评审和本地剪辑不代表付费生成或平台发布达标" },
  }, { eventId: row.event_id, synced: verified, sourceVerified: verified });
}

function failureOf(error: unknown): { code: string; uncertain: boolean } {
  return error instanceof TRPCError && error.code !== "INTERNAL_SERVER_ERROR"
    ? { code: error.code, uncertain: false } : { code: "EXECUTION_UNKNOWN", uncertain: true };
}

export function buildAgentRouter(dependencies: { dispatch: (ctx: TrpcContext, input: AgentTaskInput) => Promise<unknown> }) {
  return router({
    taskDispatch: agentWriteProcedure.input(taskDispatchInput).mutation(async ({ ctx, input }) => {
      const ledger = ledgerFor(ctx);
      const { idempotencyKey, ...request } = input;
      // Read-back by the original key must still work if the selected employee is subsequently disabled.
      const claimed = await ledger.claim("task.dispatch", idempotencyKey, agentInputHash("task.dispatch", request),
        { cancellable: !(request.runImmediately && videoGoal.test(request.title)) });
      if (claimed.owner) {
        try {
          await readyPreset(ledger, request.presetKey);
          const ref: AgentInvocationRef = { id: claimed.row.id, ownerToken: claimed.row.owner_token, memberNo: ledger.scope.memberNo, action: "task.dispatch" };
          const result = await dependencies.dispatch({ ...ctx, agentInvocation: ref }, input);
          await ledger.finish(claimed.row, record(result));
        } catch (error) { await ledger.finish(claimed.row, { code: failureOf(error).code }, failureOf(error)); }
      }
      return taskReceipt(ledger, await ledger.read(claimed.row.id), "core.task.dispatch", "execute", !claimed.owner);
    }),
    taskReceipt: protectedProcedure.input(invocationInput).query(async ({ ctx, input }) => {
      const ledger = ledgerFor(ctx);
      return taskReceipt(ledger, await ledger.read(input.invocationId), "core.task.receipt", "receipt");
    }),
    taskCancel: agentWriteProcedure
      .input(invocationInput.extend({ idempotencyKey: key }).strict()).mutation(async ({ ctx, input }) => {
        const ledger = ledgerFor(ctx);
        const claimed = await ledger.claim("task.cancel", input.idempotencyKey, agentInputHash("task.cancel", { invocationId: input.invocationId }));
        if (claimed.owner) {
          try { await ledger.cancel(claimed.row, input.invocationId); }
          catch (error) { await ledger.finish(claimed.row, { code: failureOf(error).code }, failureOf(error)); }
        }
        const row = await ledger.read(claimed.row.id);
        return envelope("core.task.cancel", "execute", row.state === "resolved" ? "succeeded" : row.state === "failed" ? "failed" : "pending",
          agentDataMode(await profileMode(ledger)), { ...publicInvocation(row, !claimed.owner), cancellation: row.result },
          { eventId: row.event_id, synced: row.state === "resolved", sourceVerified: row.event_id !== null });
      }),
    taskArtifact: protectedProcedure.input(artifactInput).query(async ({ ctx, input }) => {
      const ledger = ledgerFor(ctx);
      const row = await ledger.read(input.invocationId);
      const data = await taskData(ledger, row);
      if (data.truncated) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "事件过多，当前取件索引不完整" });
      const file = await agentArtifactData(artifactsFromEvents(data.events.map((event) => event.payload)), input.index, taskArtifactRoots(ledger.scope.workspaceId));
      return envelope("core.task.artifact", "receipt", "succeeded", agentDataMode(await profileMode(ledger)),
        { invocationId: row.id, artifact: file }, { synced: true, sourceVerified: file.sourceVerified });
    }),
    filmStart: agentWriteProcedure.input(filmStartInput).mutation(async ({ ctx, input }) => {
      const ledger = ledgerFor(ctx);
      const { idempotencyKey, ...request } = input;
      let normalized: ReturnType<typeof normalizeFilmJobRequest>;
      try { normalized = normalizeFilmJobRequest(request.stages, request.options); }
      catch { throw new TRPCError({ code: "BAD_REQUEST", message: "阶段或工位选项不在受控范围内" }); }
      const normalizedRequest = { ...request, stages: normalized.stages, options: normalized.options };
      const claimed = await ledger.claim("film.start", idempotencyKey, agentInputHash("film.start", normalizedRequest));
      if (claimed.owner) {
        try {
          const ref: AgentInvocationRef = { id: claimed.row.id, ownerToken: claimed.row.owner_token, memberNo: ledger.scope.memberNo, action: "film.start" };
          const result = await filmRouter.createCaller({ ...ctx, agentInvocation: ref }).start(normalizedRequest);
          await ledger.finish(claimed.row, record(result));
        } catch (error) { await ledger.finish(claimed.row, { code: failureOf(error).code }, failureOf(error)); }
      }
      return filmReceipt(ledger, await ledger.read(claimed.row.id), "video.film.start", "execute", !claimed.owner);
    }),
    filmReceipt: protectedProcedure.input(invocationInput).query(async ({ ctx, input }) => {
      const ledger = ledgerFor(ctx);
      return filmReceipt(ledger, await ledger.read(input.invocationId), "video.film.receipt", "receipt");
    }),
    filmArtifact: protectedProcedure.input(artifactInput).query(async ({ ctx, input }) => {
      const ledger = ledgerFor(ctx);
      const row = await ledger.read(input.invocationId);
      if (row.action !== "film.start" || row.entity_kind !== "film" || !row.entity_id) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "调用尚未绑定影片作业" });
      }
      const job = await new FilmLedger(getAppPool(), ledger.scope).readJob(row.entity_id);
      if (!job || job.created_by !== ledger.scope.memberNo) throw new TRPCError({ code: "NOT_FOUND", message: "影片作业不属于当前成员" });
      const files = await filmArtifacts(job);
      const file = await agentArtifactData(files.items, input.index, files.roots);
      return envelope("video.film.artifact", "receipt", "succeeded", agentDataMode(await profileMode(ledger)),
        { invocationId: row.id, artifact: file }, { synced: true, sourceVerified: file.sourceVerified });
    }),
  });
}
