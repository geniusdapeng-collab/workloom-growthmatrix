import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { downloadMedia } from "./media-download.js";

describe("existing media retrieval", () => {
  let root: string, file: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "workloom-media-get-")); file = join(root, "clip.mp4"); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const url = "https://media.invalid/clip.mp4?X-Tos-Signature=private-access";
  const timeout = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });

  it("writes a complete successful GET without submitting generation", async () => {
    const calls: string[] = [];
    await downloadMedia({ url, file, fetchImpl: async (target, init) => {
      expect(target).toBe(url); expect(init?.body).toBeUndefined(); calls.push(init?.method ?? "");
      return new Response(new Uint8Array([1, 2, 3]));
    } });
    expect(calls).toEqual(["GET"]); expect([...readFileSync(file)]).toEqual([1, 2, 3]);
  });

  it("recovers connection and mid-body failures with GET only and retains previous bytes until success", async () => {
    writeFileSync(file, "previous"); let calls = 0;
    const delays: number[] = [], diagnostics: string[] = [];
    await downloadMedia({ url, file, sleep: async ms => { delays.push(ms); }, log: message => diagnostics.push(message),
      fetchImpl: async (_target, init) => {
        expect(init?.method).toBe("GET"); expect(readFileSync(file, "utf8")).toBe("previous"); calls++;
        if (calls === 1) throw timeout();
        if (calls === 2) return Object.assign(new Response("partial"), { arrayBuffer: async () => { throw timeout(); } });
        return new Response("complete");
      } });
    expect(calls).toBe(3); expect(delays).toEqual([1000, 2000]); expect(readFileSync(file, "utf8")).toBe("complete");
    expect(diagnostics.every(message => !message.includes(url) && !message.includes("private-access"))).toBe(true);
  });

  it("bounds persistent network failures and preserves the existing file", async () => {
    writeFileSync(file, "previous"); let calls = 0; const delays: number[] = [];
    await expect(downloadMedia({ url, file, sleep: async ms => { delays.push(ms); },
      fetchImpl: async () => { calls++; throw timeout(); } })).rejects.toThrow(/GET 请求 3 次/);
    expect(calls).toBe(3); expect(delays).toEqual([1000, 2000]); expect(readFileSync(file, "utf8")).toBe("previous");
  });

  it("retries a temporary HTTP failure and cancels its unused body", async () => {
    let calls = 0; const temporary = new Response("unavailable", { status: 503 });
    await downloadMedia({ url, file, sleep: async () => {}, fetchImpl: async () => ++calls === 1 ? temporary : new Response("ready") });
    expect(calls).toBe(2); expect(temporary.bodyUsed).toBe(true); expect(readFileSync(file, "utf8")).toBe("ready");
  });

  it.each([400, 401, 403, 404])("does not retry permanent HTTP %s or change previous media", async status => {
    writeFileSync(file, "previous"); let calls = 0;
    await expect(downloadMedia({ url, file, fetchImpl: async () => { calls++; return new Response("refused", { status }); } }))
      .rejects.toThrow(`HTTP ${status}`);
    expect(calls).toBe(1); expect(readFileSync(file, "utf8")).toBe("previous");
  });

  it("does not retry an unknown transport exception or leak signed access values", async () => {
    let calls = 0;
    await expect(downloadMedia({ url, file, fetchImpl: async () => { calls++; throw new Error(url); } }))
      .rejects.toThrow("不可恢复网络异常");
    expect(calls).toBe(1);
  });

  it("propagates filesystem errors without fetching again", async () => {
    mkdirSync(file); let calls = 0;
    await expect(downloadMedia({ url, file, fetchImpl: async () => { calls++; return new Response("ready"); } })).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
