/**
 * B-20/B-22 桥客户端测试：配置解析、成功回执、5xx 重试、失败 fail-closed。
 */
import { describe, expect, it, vi } from "vitest";
import { bridgeConfigFromEnv, createHttpBridgeExecutor } from "./index.js";

const scope = { tenantId: "tenant-demo", workspaceId: "ws-test" };

describe("bridge-client 配置与执行", () => {
  it("缺 URL/Token → 配置解析 undefined（宿主按 connector-required）", () => {
    expect(bridgeConfigFromEnv("A_URL", "A_TOKEN", {})).toBeUndefined();
    expect(bridgeConfigFromEnv("A_URL", "A_TOKEN", { A_URL: "https://b.example/" })).toBeUndefined();
    expect(bridgeConfigFromEnv("A_URL", "A_TOKEN", { A_URL: "https://b.example/", A_TOKEN: "t" }))
      .toEqual({ baseUrl: "https://b.example", token: "t" });
  });

  it("成功：POST /tools/execute 带 scope，回执透传", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      result: { postId: "p-1" },
      receipt: { synced: true, snapshot_uri: "bridge://p-1", verified_at: "2026-09-22T01:00:00Z" },
    }), { status: 200 }));
    const exec = createHttpBridgeExecutor({ baseUrl: "https://b.example", token: "t", scope, fetchImpl: fetchImpl as never });
    const out = await exec("publish.dispatch", { accountId: "acc-1" });
    expect(out.result.postId).toBe("p-1");
    expect(out.receipt.synced).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://b.example/tools/execute");
    expect(JSON.parse(String(init.body))).toMatchObject({ tool: "publish.dispatch", scope });
  });

  it("5xx 重试一次后仍失败 → connector-required；网络异常同样 fail-closed", async () => {
    const flaky = vi.fn()
      .mockResolvedValueOnce(new Response("boom", { status: 503 }))
      .mockResolvedValueOnce(new Response("boom", { status: 503 }));
    const exec = createHttpBridgeExecutor({ baseUrl: "https://b.example", token: "t", scope, fetchImpl: flaky as never });
    const out = await exec("publish.dispatch", {});
    expect(out.receipt.synced).toBe(false);
    expect(out.result.state).toBe("connector-required");
    expect(flaky).toHaveBeenCalledTimes(2);

    const broken = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const exec2 = createHttpBridgeExecutor({ baseUrl: "https://b.example", token: "t", scope, fetchImpl: broken as never });
    expect((await exec2("source.publish", {})).receipt.synced).toBe(false);
  });

  it("回执缺 synced 字段 → 视为未核实（不采信伪造形状）", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ result: { ok: true } }), { status: 200 }));
    const exec = createHttpBridgeExecutor({ baseUrl: "https://b.example", token: "t", scope, fetchImpl: fetchImpl as never });
    expect((await exec("dm.reply", {})).receipt.synced).toBe(false);
  });
});
