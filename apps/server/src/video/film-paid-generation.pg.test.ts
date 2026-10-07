/** Actual PostgreSQL/RLS/concurrency tests. Injected provider never makes a paid network call. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { FilmLedger, type FilmComponentRow, type FilmJobRow } from "./film-ledger.js";
import type { AppPool } from "./gen/db.js";
import { compileProviderRequest, renderSha256, type CompiledProviderRequest } from "./gen/compiled-request.js";
import { filmPaidRequestIdentity, obtainFilmPaidTask } from "./film-paid-generation.js";

const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL) && Boolean(process.env.DATABASE_APP_URL);
const hash = renderSha256;
describe.runIf(RUN_DB)("paid film submissions on real PostgreSQL", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL, max: 12, connectionTimeoutMillis: 3_000 });
  const suffix = randomBytes(6).toString("hex");
  const scope = { tenantId: `t-paid-${suffix}`, workspaceId: `w-paid-${suffix}` }, projectId = `p-paid-${suffix}`;
  const ledger = new FilmLedger(app as unknown as AppPool, scope);
  let workerId: string;
  beforeAll(async () => {
    await owner.query("INSERT INTO tenants(id,name,plan) VALUES($1,'paid film tests','community')", [scope.tenantId]);
    await owner.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry) VALUES($1,$2,'paid film tests',$1,'general')", [scope.workspaceId, scope.tenantId]);
    await owner.query("INSERT INTO video_projects(id,workspace_id,title,kind,created_by) VALUES($1,$2,'paid film tests','narrative','MEM-test')", [projectId, scope.workspaceId]);
    const worker = await ledger.registerWorker({ workerName: "paid-test", workerVersion: "v1", entryPath: "scripts/tools/full-chain-film.mts",
      entrySha256: hash("worker"), capabilities: ["image", "video"], actor: "MEM-test" });
    workerId = worker.id;
  });
  afterAll(async () => { await app.end(); await owner.end(); });
  async function job(source = "source"): Promise<FilmJobRow> {
    return ledger.claimJob({ projectId, workerId, runId: `test-${randomBytes(6).toString("hex")}`, stages: ["plates", "videos"], options: {}, budgetCny: 50,
      inputRef: `inputs/${hash(source)}.json`, inputSha256: hash(source), workerEntrySha256: hash("worker"), actor: "MEM-test" });
  }
  function compiled(shot: string, options: { provider?: "seedance" | "seedream"; model?: string; seed?: number; endpoint?: string; prompt?: string } = {}) {
    const provider = options.provider ?? "seedance";
    return compileProviderRequest(provider, { prompt: options.prompt ?? `original ${shot}`, refId: shot, estimatedUnits: 5,
      params: { providerModel: options.model ?? `test-${provider}`, durationSec: 5, seed: options.seed ?? 123 } }, { baseUrl: options.endpoint });
  }
  async function component(row: FilmJobRow, shot: string, options: { key?: string; provider?: "seedance" | "seedream"; payload?: string } = {}): Promise<FilmComponentRow> {
    const type = options.provider === "seedream" ? "image" as const : "video" as const;
    const stage = type === "image" ? "plates" : "videos";
    const reserved = await ledger.reserveComponent({ jobId: row.id, component: type, stepKey: `${stage}:${shot}`, shotId: shot,
      idempotencyKey: options.key ?? `key-${randomBytes(6).toString("hex")}`, requestHash: hash(`request-${shot}`), payloadHash: hash(options.payload ?? `payload-${shot}`), reservedCny: 2 });
    const claimed = await ledger.claimComponent(reserved.row.id, `owner-${reserved.row.id}`);
    if (!claimed) throw new Error("test fixture claim failed");
    return claimed;
  }
  async function obtain(row: FilmComponentRow, input: CompiledProviderRequest, submit = vi.fn(async () => ({ taskId: `task-${row.id}` }))) {
    return obtainFilmPaidTask({ ledger, componentId: row.id, ownerToken: row.owner_token!, compiled: input, signal: new AbortController().signal, submit });
  }
  async function rawScoped(sql: string, params: unknown[]) {
    const client = await app.connect();
    try {
      await client.query("BEGIN"); await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.workspace_id',$2,true)", [scope.tenantId, scope.workspaceId]);
      const result = await client.query(sql, params); await client.query("COMMIT"); return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  it("deduplicates concurrent changed caller keys for one complete request within a job", async () => {
    const row = await job("caller-key-test");
    const results = await Promise.all(Array.from({ length: 8 }, (_, n) => ledger.reserveComponent({ jobId: row.id, component: "video", stepKey: "videos:key-test", shotId: "key-test",
      idempotencyKey: `changed-key-${n}`, requestHash: hash("same-request"), payloadHash: hash("same-payload"), reservedCny: 2 })));
    expect(new Set(results.map(r => r.row.id)).size).toBe(1);
    expect(results.filter(r => !r.deduped)).toHaveLength(1);
    expect((await ledger.jobStatus(row.id))?.reservedCny).toBe(2);
  });

  it.each(["seedance", "seedream"] as const)("persists %s ACK before a download failure and reuses it in a new job", async (provider) => {
    const shot = `download-${provider}`, first = await component(await job(shot), shot, { provider }), input = compiled(shot, { provider });
    const submit = vi.fn(async () => ({ taskId: `task-${provider}` }));
    await obtain(first, input, submit);
    await ledger.recordComponentFailure(first.id, first.owner_token!, { state: "unknown", failureClass: "MEDIA_FETCH_UNKNOWN", evidence: { downloadFailed: true } });
    expect((await ledger.componentById(first.id))?.evidence.providerTaskId).toBe(`task-${provider}`);
    const second = await component(await job(shot), shot, { provider });
    const recovered = await obtain(second, input, submit);
    expect(recovered).toEqual({ taskId: `task-${provider}`, reused: true, sourceComponentId: first.id });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(Number((await ledger.componentById(second.id))?.reserved_cny)).toBe(0);
    await ledger.recordComponentAccepted(second.id, second.owner_token!, { provider, providerModel: `test-${provider}`, actualCny: 0,
      evidence: { artifactSha256: hash("real-test-artifact"), providerTaskId: recovered.taskId } });
    expect((await ledger.jobStatus(second.job_id))?.spentCny).toBe(0);
  });

  it("a lost response cannot be paid again by changing the job or key", async () => {
    const shot = "lost-response", input = compiled(shot), first = await component(await job(shot), shot);
    const submit = vi.fn(async () => { throw new Error("response lost after provider accepted"); });
    await expect(obtain(first, input, submit)).rejects.toThrow("response lost");
    await ledger.recordComponentFailure(first.id, first.owner_token!, { state: "unknown", failureClass: "NETWORK_RESPONSE_UNKNOWN" });
    const second = await component(await job(shot), shot);
    await expect(obtain(second, input, submit)).rejects.toMatchObject({ code: "PAID_RECONCILIATION_REQUIRED" });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it.each(["prompt", "model", "seed", "endpoint"])("same original source with a changed %s cannot silently become another paid attempt", async (field) => {
    const shot = `changed-${field}`, input = compiled(shot), first = await component(await job(shot), shot);
    const submit = vi.fn(async () => ({ taskId: `task-${field}` })); await obtain(first, input, submit);
    const second = await component(await job(shot), shot, { payload: `changed-${field}` });
    const changed = compiled(shot, { [field]: field === "seed" ? 456 : field === "endpoint" ? "https://changed.test/api/v3" : `changed-${field}` });
    await expect(obtain(second, changed, submit)).rejects.toMatchObject({ code: "PAID_RECONCILIATION_REQUIRED" });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("a genuinely changed frozen source may authorize a different request; exact prior bytes are still reused", async () => {
    const shot = "new-version", first = await component(await job("version-1"), shot), input = compiled(shot);
    let submittedCount = 0;
    const submit = vi.fn(async () => ({ taskId: `task-${++submittedCount}` }));
    await obtain(first, input, submit);
    const second = await component(await job("version-2"), shot);
    const reused = await obtain(second, input, submit); expect(reused.reused).toBe(true);
    const third = await component(await job("version-3"), shot, { payload: "new-creative-payload" });
    const changed = await obtain(third, compiled(shot, { prompt: "new approved story version" }), submit);
    expect(changed.reused).toBe(false); expect(submit).toHaveBeenCalledTimes(2);
  });

  it("simultaneous jobs issue at most one paid submission for the same intent", async () => {
    const shot = "concurrent", input = compiled(shot);
    const components = await Promise.all(Array.from({ length: 6 }, async () => component(await job(shot), shot)));
    const submit = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 20)); return { taskId: "one-concurrent-task" }; });
    const results = await Promise.allSettled(components.map(row => obtain(row, input, submit)));
    expect(submit).toHaveBeenCalledTimes(1); expect(results.some(r => r.status === "fulfilled")).toBe(true);
    for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "PAID_RECONCILIATION_REQUIRED" });
    const rows = await owner.query("SELECT SUM(dispatch_count)::int AS n FROM film_component_requests WHERE project_id=$1 AND shot_id=$2", [projectId, shot]);
    expect(rows.rows[0]?.n).toBe(1);
  });

  it("keeps a late ACK on an unknown component without changing its terminal state", async () => {
    const shot = "late-ACK", row = await component(await job(shot), shot), identity = filmPaidRequestIdentity(compiled(shot));
    await ledger.beginPaidDispatch(row.id, row.owner_token!, identity);
    await ledger.recordComponentFailure(row.id, row.owner_token!, { state: "unknown", failureClass: "JOB_DEADLINE_EXCEEDED" });
    await ledger.recordProviderTaskAccepted(row.id, row.owner_token!, identity, "late-task");
    const saved = await ledger.componentById(row.id);
    expect(saved?.state).toBe("unknown"); expect(saved?.evidence.providerTaskId).toBe("late-task");
    await ledger.recordProviderTaskAccepted(row.id, row.owner_token!, identity, "late-task");
    expect((await ledger.componentById(row.id))?.evidence.paidAcceptedAt).toBe(saved?.evidence.paidAcceptedAt);
    await expect(ledger.recordProviderTaskAccepted(row.id, "other-owner", identity, "late-task")).rejects.toMatchObject({ code: "FILM_COMPONENT_STATE_CONFLICT" });
    await expect(ledger.recordProviderTaskAccepted(row.id, row.owner_token!, identity, "changed-task")).rejects.toMatchObject({ code: "FILM_COMPONENT_STATE_CONFLICT" });
  });

  it("RLS hides paid intent and rejects a foreign-tenant dispatch even in the same workspace", async () => {
    const shot = "scope-test", row = await component(await job(shot), shot);
    const foreign = new FilmLedger(app as unknown as AppPool, { ...scope, tenantId: "another-tenant" });
    expect(await foreign.componentById(row.id)).toBeNull();
    await expect(foreign.beginPaidDispatch(row.id, row.owner_token!, filmPaidRequestIdentity(compiled(shot)))).rejects.toMatchObject({ code: "FILM_COMPONENT_STATE_CONFLICT" });
    expect((await app.query("SELECT id FROM film_component_requests")).rowCount).toBe(0);
    expect((await ledger.componentById(row.id))?.dispatch_count).toBe(0);
  });

  it("normal dispatch cannot bypass complete paid identity admission", async () => {
    const row = await component(await job("normal-dispatch-bypass"), "normal-dispatch-bypass");
    await expect(ledger.recordDispatch(row.id, row.owner_token!, "seedance", "model")).rejects.toMatchObject({ code: "PAID_DISPATCH_IDENTITY_REQUIRED" });
    expect((await ledger.componentById(row.id))?.dispatch_count).toBe(0);
  });

  it("database and application reject replacing paid identity, ACK, counter or provider in later receipts", async () => {
    const shot = "immutable", row = await component(await job(shot), shot), input = compiled(shot); await obtain(row, input);
    for (const patch of [{ providerTaskId: "new-task" }, { paidRequest: filmPaidRequestIdentity(compiled(shot, { seed: 789 })) }, { paidSourceComponentId: "another-component" }]) {
      await expect(rawScoped("UPDATE film_component_requests SET evidence=evidence || $2::jsonb WHERE id=$1", [row.id, JSON.stringify(patch)])).rejects.toThrow("immutable");
    }
    await expect(rawScoped("UPDATE film_component_requests SET dispatch_count=2 WHERE id=$1", [row.id])).rejects.toThrow("immutable");
    await expect(ledger.recordComponentFailure(row.id, row.owner_token!, { state: "unknown", failureClass: "failure", evidence: { providerTaskId: "changed" } })).rejects.toMatchObject({ code: "FILM_COMPONENT_RECEIPT_INVALID" });
    await expect(ledger.recordComponentAccepted(row.id, row.owner_token!, { provider: "other", providerModel: "test-seedance", actualCny: 0,
      evidence: { artifactSha256: hash("artifact") } })).rejects.toMatchObject({ code: "FILM_COMPONENT_RECEIPT_INVALID" });
    expect((await ledger.componentById(row.id))?.evidence.providerTaskId).toBe(`task-${row.id}`);
  });

  it("legacy dispatched records without a complete request require reconciliation for the same frozen source", async () => {
    const shot = "legacy", row = await component(await job(shot), shot);
    await rawScoped("UPDATE film_component_requests SET dispatch_count=1,provider='seedance',provider_model='legacy-model' WHERE id=$1", [row.id]);
    const next = await component(await job(shot), shot), submit = vi.fn();
    await expect(obtain(next, compiled(shot), submit)).rejects.toMatchObject({ code: "PAID_RECONCILIATION_REQUIRED" });
    expect(submit).not.toHaveBeenCalled();
  });
});
