import { afterEach, describe, expect, it, vi } from "vitest";
import { compileProviderRequest, canonicalRenderJson, renderSha256 } from "./gen/compiled-request.js";
import { filmPaidRequestIdentity, obtainFilmPaidTask, replayFilmPaidResult, submitBoundFilmRequest } from "./film-paid-generation.js";
import { ArkVideoProvider } from "./gen/providers.js";

const request = { prompt: "registered shot, uninterrupted action", estimatedUnits: 5, refId: "S1", params: {
  providerModel: "test-seedance", durationSec: 5, seed: 123, referenceImageUrls: ["asset://test-approved"], generateAudio: true,
} };
const compiled = () => compileProviderRequest("seedance", request);
const ledger = () => ({
  beginPaidDispatch: vi.fn(async () => ({ mode: "submit" as const })),
  recordProviderTaskAccepted: vi.fn(async () => undefined),
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("film paid task acceptance and fault recovery", () => {
  it("persists the complete intent then the actual ACK before the caller can poll/download", async () => {
    const trace: string[] = [];
    const target = ledger();
    target.beginPaidDispatch.mockImplementation(async () => { trace.push("reserve-paid"); return { mode: "submit" }; });
    target.recordProviderTaskAccepted.mockImplementation(async () => { trace.push("persist-ACK"); });
    const submit = vi.fn(async () => { trace.push("POST"); return { taskId: "accepted-task" }; });
    const task = await obtainFilmPaidTask({ ledger: target, componentId: "C1", ownerToken: "owner", compiled: compiled(),
      signal: new AbortController().signal, submit });
    trace.push("poll-or-download");
    expect(trace).toEqual(["reserve-paid", "POST", "persist-ACK", "poll-or-download"]);
    expect(task).toEqual({ taskId: "accepted-task", reused: false, sourceComponentId: "C1" });
    expect(target.recordProviderTaskAccepted).toHaveBeenCalledWith("C1", "owner", filmPaidRequestIdentity(compiled()), "accepted-task");
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("reuses a known task across jobs with zero paid calls", async () => {
    const target = { ...ledger(), beginPaidDispatch: vi.fn(async () => ({ mode: "reuse" as const, taskId: "prior-task", sourceComponentId: "C0" })) };
    const submit = vi.fn();
    const result = await obtainFilmPaidTask({ ledger: target, componentId: "C1", ownerToken: "owner", compiled: compiled(), signal: new AbortController().signal, submit });
    expect(result).toEqual({ taskId: "prior-task", reused: true, sourceComponentId: "C0" });
    expect(submit).not.toHaveBeenCalled();
    expect(target.recordProviderTaskAccepted).not.toHaveBeenCalled();
  });

  it.each(["timeout-after-acceptance", "HTTP 503", "response-lost"])("does not retry a paid %s failure", async (message) => {
    const target = ledger(), submit = vi.fn(async () => { throw new Error(message); });
    await expect(obtainFilmPaidTask({ ledger: target, componentId: "C1", ownerToken: "owner", compiled: compiled(), signal: new AbortController().signal, submit })).rejects.toThrow(message);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(target.recordProviderTaskAccepted).not.toHaveBeenCalled();
  });

  it("a failed durable ACK write does not repeat the paid submission", async () => {
    const target = ledger();
    target.recordProviderTaskAccepted.mockRejectedValue(new Error("database-unavailable"));
    const submit = vi.fn(async () => ({ taskId: "paid-task" }));
    await expect(obtainFilmPaidTask({ ledger: target, componentId: "C1", ownerToken: "owner", compiled: compiled(), signal: new AbortController().signal, submit })).rejects.toThrow("database-unavailable");
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty provider ACK after exactly one POST", async () => {
    const target = ledger(), submit = vi.fn(async () => ({ taskId: " " }));
    await expect(obtainFilmPaidTask({ ledger: target, componentId: "C1", ownerToken: "owner", compiled: compiled(), signal: new AbortController().signal, submit })).rejects.toMatchObject({ code: "PROVIDER_ACK_UNKNOWN" });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(target.recordProviderTaskAccepted).not.toHaveBeenCalled();
  });

  it("rejects a mutated complete provider body before entering the ledger", async () => {
    const input = compiled(); input.body.seed = 456;
    const target = ledger(), submit = vi.fn();
    await expect(obtainFilmPaidTask({ ledger: target, componentId: "C1", ownerToken: "owner", compiled: input, signal: new AbortController().signal, submit })).rejects.toMatchObject({ code: "PAID_REQUEST_UNVERIFIED" });
    expect(target.beginPaidDispatch).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
  });

  it("sends the privately frozen request when the caller changes its object during reservation", async () => {
    const input = compiled(), expected = structuredClone(input), target = ledger();
    target.beginPaidDispatch.mockImplementation(async () => { input.body.seed = 456; input.bodyJson = "changed"; return { mode: "submit" }; });
    const submit = vi.fn(async (frozen) => { expect(frozen).toEqual(expected); return { taskId: "task" }; });
    await obtainFilmPaidTask({ ledger: target, componentId: "C1", ownerToken: "owner", compiled: input, signal: new AbortController().signal, submit });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("an abort before reservation performs no paid work", async () => {
    const controller = new AbortController(); controller.abort(new Error("cancelled"));
    const target = ledger(), submit = vi.fn();
    await expect(obtainFilmPaidTask({ ledger: target, componentId: "C1", ownerToken: "owner", compiled: compiled(), signal: controller.signal, submit })).rejects.toThrow("cancelled");
    expect(target.beginPaidDispatch).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
  });

  it("persists a late ACK after an abort, then reports the abort to the caller", async () => {
    const target = ledger(), controller = new AbortController();
    const submit = vi.fn(async () => { controller.abort(new Error("job-closed")); return { taskId: "late-task" }; });
    await expect(obtainFilmPaidTask({ ledger: target, componentId: "C1", ownerToken: "owner", compiled: compiled(), signal: controller.signal, submit })).rejects.toThrow("job-closed");
    expect(target.recordProviderTaskAccepted).toHaveBeenCalledWith("C1", "owner", filmPaidRequestIdentity(compiled()), "late-task");
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("a transport request cannot differ from the intent already stored in the ledger", async () => {
    const provider = { submit: vi.fn() };
    await expect(submitBoundFilmRequest({ compiled: compiled(), request: { ...request, prompt: "changed" }, endpoint: {}, provider })).rejects.toMatchObject({ code: "PAID_REQUEST_CHANGED" });
    expect(provider.submit).not.toHaveBeenCalled();
  });

  it("the actual Ark adapter posts the exact compiled JSON once after intent persistence", async () => {
    const trace: string[] = [], target = ledger();
    target.beginPaidDispatch.mockImplementation(async () => { trace.push("intent"); return { mode: "submit" }; });
    target.recordProviderTaskAccepted.mockImplementation(async () => { trace.push("ACK"); });
    const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      trace.push("POST"); expect(init.body).toBe(compiled().bodyJson);
      return new Response(JSON.stringify({ id: "fake-provider-test-task" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);
    const provider = new ArkVideoProvider({ apiKey: "test-only-ark-key" });
    await obtainFilmPaidTask({ ledger: target, componentId: "C1", ownerToken: "owner", compiled: compiled(), signal: new AbortController().signal,
      submit: (frozen) => submitBoundFilmRequest({ compiled: frozen, request, endpoint: {}, provider }) });
    expect(trace).toEqual(["intent", "POST", "ACK"]); expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("paid result replay", () => {
  const bytes = Buffer.from("actual saved file bytes");
  const result = { ref: "clips/S1.mp4", sha256: renderSha256(bytes), bytes: bytes.byteLength, hostedUrl: "https://provider.test/S1.mp4" };
  const evidence = () => ({ artifactRef: result.ref, artifactSha256: result.sha256, artifactBytes: result.bytes,
    result, resultSha256: renderSha256(canonicalRenderJson(result)) });
  it("replays the exact result only after reading and hashing the actual artifact", async () => {
    const readArtifact = vi.fn(async () => bytes);
    expect(await replayFilmPaidResult({ evidence: evidence(), readArtifact })).toEqual(result);
    expect(readArtifact).toHaveBeenCalledWith(result.ref);
  });
  it.each(["corrupt", "empty"])("rejects a %s artifact without a paid recovery call", async (kind) => {
    await expect(replayFilmPaidResult({ evidence: evidence(), readArtifact: async () => kind === "empty" ? Buffer.alloc(0) : Buffer.from("changed") })).rejects.toMatchObject({ code: "PAID_RESULT_UNVERIFIED" });
  });
  it("does not fabricate an artifact result for legacy receipts", async () => {
    await expect(replayFilmPaidResult({ evidence: { artifactSha256: result.sha256 }, readArtifact: vi.fn() })).rejects.toMatchObject({ code: "PAID_RESULT_RECOVERY_REQUIRED" });
  });
  it("rejects a changed saved response before reading its artifact", async () => {
    const readArtifact = vi.fn();
    await expect(replayFilmPaidResult({ evidence: { ...evidence(), result: { ...result, ref: "other.mp4" } }, readArtifact })).rejects.toMatchObject({ code: "PAID_RESULT_RECOVERY_REQUIRED" });
    expect(readArtifact).not.toHaveBeenCalled();
  });
});
