import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { test } from "node:test";
import { invokeCapability, loadCatalog, mcpTools, validateInput } from "./agent-capabilities.mjs";

const root = resolve(import.meta.dirname, "..");
const expected = ["core.task.dispatch", "core.task.receipt", "core.task.cancel", "core.task.artifact",
  "video.film.start", "video.film.receipt", "video.film.artifact"];

test("execution catalog exposes dispatch, scoped receipts, cancel and fixed film stages", async () => {
  const catalog = await loadCatalog(root);
  for (const id of expected) assert.ok(catalog.entries.has(id), id);
  for (const id of ["core.task.dispatch", "core.task.cancel", "video.film.start"]) {
    const descriptor = catalog.entries.get(id);
    assert.equal(descriptor.operation, "execute");
    assert.ok(descriptor.inputSchema.required.includes("idempotencyKey"));
    assert.equal(descriptor.transport.method, "mutation");
    const tool = mcpTools(catalog).find((row) => row.name === "workloom_" + id.replaceAll(".", "_"));
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.equal(tool.annotations.idempotentHint, true);
  }
  assert.equal(catalog.entries.get("core.task.receipt").transport.path, "agent.taskReceipt");
});

test("dispatch rejects missing keys, blank goals, caller identity and arbitrary tool plans before I/O", async () => {
  const catalog = await loadCatalog(root);
  const descriptor = catalog.entries.get("core.task.dispatch");
  assert.ok(descriptor);
  for (const input of [{ title: "读取任务" }, { title: "", idempotencyKey: "12345678" },
    { title: "读取任务", idempotencyKey: "12345678", tenantId: "other" },
    { title: "读取任务", idempotencyKey: "12345678", tool: "shell.exec" },
    { title: "读取任务", idempotencyKey: "12345678", steps: [] }]) {
    assert.throws(() => validateInput(descriptor, input));
  }
  assert.deepEqual(validateInput(descriptor, { title: "中文任务 🧶", idempotencyKey: "fixture-key-01", presetKey: "content-calendar-officer" }),
    { title: "中文任务 🧶", idempotencyKey: "fixture-key-01", presetKey: "content-calendar-officer" });
});

async function fixture(work) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, path: req.url, input: body ? JSON.parse(body) : null });
    const id = req.url.startsWith("/trpc/agent.taskReceipt") ? "core.task.receipt" : "core.task.dispatch";
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ result: { data: {
      schemaVersion: "workloom.capability-result/v1", capabilityId: id,
      operation: id.endsWith("receipt") ? "receipt" : "execute", status: "pending", dataMode: "simulated",
      result: { invocationId: "00000000-0000-4000-8000-000000000001", state: "linked", thread: { id: "T-fixture", status: "queued" } },
      receipt: { synced: false, sourceVerified: false, businessVerified: false },
    } } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await work("http://127.0.0.1:" + server.address().port, requests); }
  finally { await new Promise((done) => server.close(done)); }
}

test("CLI transport retains server pending receipt and sends only reviewed member mutation", async () => {
  await fixture(async (baseUrl, requests) => {
    const catalog = await loadCatalog(root);
    const output = await invokeCapability(catalog, "core.task.dispatch", { title: "生成内容日历", idempotencyKey: "fixture-key-02" },
      { baseUrl, env: { WORKLOOM_ACCESS_TOKEN: "unit-fixture-only", WORKLOOM_DEV_AUTO_LOGIN: "0" } });
    assert.equal(output.status, "pending");
    assert.equal(output.receipt.businessVerified, false);
    assert.equal(output.result.thread.status, "queued");
    assert.deepEqual(requests, [{ method: "POST", path: "/trpc/agent.taskDispatch",
      input: { title: "生成内容日历", idempotencyKey: "fixture-key-02" } }]);
  });
});

test("execution never promotes a source receipt to verified real business data", async () => {
  const catalog = await loadCatalog(root);
  await assert.rejects(invokeCapability(catalog, "core.task.dispatch", { title: "测试派单", idempotencyKey: "fixture-key-03" }, {
    baseUrl: "http://127.0.0.1:33333", env: { WORKLOOM_ACCESS_TOKEN: "unit-fixture-only" },
    fetcher: async () => ({ ok: true, json: async () => ({ result: { data: {
      schemaVersion: "workloom.capability-result/v1", capabilityId: "core.task.dispatch", operation: "execute", status: "succeeded", dataMode: "real",
    } } }) }),
  }), (error) => error.code === "REMOTE_INVALID");
});

test("real stdio MCP call uses the same mutation and preserves the pending envelope", async () => {
  await fixture(async (baseUrl, requests) => {
    const child = spawn(process.execPath, [resolve(root, "scripts/workloom-agent-mcp.mjs")], {
      cwd: root, env: { ...process.env, WORKLOOM_BASE_URL: baseUrl, WORKLOOM_ACCESS_TOKEN: "unit-fixture-only", WORKLOOM_DEV_AUTO_LOGIN: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: {
      name: "workloom_core_task_dispatch", arguments: { title: "生成内容日历", presetKey: "content-calendar-officer", idempotencyKey: "fixture-key-04" },
    } }) + "\n");
    const [code] = await once(child, "exit");
    assert.equal(code, 0, stderr);
    const response = JSON.parse(stdout.trim());
    assert.equal(response.id, 7);
    assert.equal(response.result.isError, false);
    const output = JSON.parse(response.result.content[0].text);
    assert.equal(output.status, "pending");
    assert.equal(output.dataMode, "simulated");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].input.presetKey, "content-calendar-officer");
  });
});
