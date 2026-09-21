import { describe, expect, it, vi } from "vitest";
import { canonicalJson, toolIdempotencyKey, withToolContract } from "./tool-contract.js";

const scope = { tenantId: "tenant-demo", workspaceId: "ws-geo" };

describe("B-57 工具调用契约", () => {
  it("幂等键稳定：键序无关、同参同键、异参异键", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }));
    const k1 = toolIdempotencyKey(scope, "visualwrite.compose", { spec: "poster", n: 2 });
    const k2 = toolIdempotencyKey(scope, "visualwrite.compose", { n: 2, spec: "poster" });
    const k3 = toolIdempotencyKey(scope, "visualwrite.compose", { n: 3, spec: "poster" });
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k1).toHaveLength(32);
  });

  it("成功：参数自动带 idempotencyKey；失败重试后可返回 connector-required", async () => {
    const calls: string[] = [];
    const ok = await withToolContract("publish.dispatch", { accountId: "a1" }, async (params) => {
      calls.push(params.idempotencyKey);
      return { result: { state: "done" }, receipt: { synced: true } };
    }, { scope, timeoutMs: 500, retries: 1, sleep: async () => {} });
    expect(ok.receipt.synced).toBe(true);
    expect(calls[0]).toHaveLength(32);

    let attempts = 0;
    const failed = await withToolContract("publish.dispatch", {}, async () => {
      attempts += 1;
      throw new Error("bridge down");
    }, { scope, timeoutMs: 500, retries: 2, sleep: async () => {} });
    expect(attempts).toBe(3);
    expect(failed.receipt.synced).toBe(false);
    expect(failed.result.state).toBe("connector-required");
  });

  it("超时按契约返回未核实（不悬挂）", async () => {
    const result = await withToolContract("slow.tool", {}, async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { result: { state: "late" }, receipt: { synced: true } };
    }, { scope, timeoutMs: 5, retries: 0 });
    expect(result.receipt.synced).toBe(false);
    expect(result.result.state).toBe("connector-required");
  });
});
