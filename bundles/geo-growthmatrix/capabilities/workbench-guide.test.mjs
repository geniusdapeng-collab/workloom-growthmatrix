import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { invokeCapability, loadCatalog, mcpTools } from "../../../scripts/agent-capabilities.mjs";
import { GUIDE_PATH, GUIDE_VERSION, workbenchGuide } from "./workbench-guide.mjs";
import { productionPlan } from "./video.mjs";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const ID = "growth.video.workbench.guide";
const MODULE = "bundles/geo-growthmatrix/capabilities/workbench-guide.mjs";
const CLI = join(ROOT, "scripts/workloom-agent.mjs");
const MCP = join(ROOT, "scripts/workloom-agent-mcp.mjs");
const canonical = readFileSync(join(ROOT, GUIDE_PATH));
const digest = createHash("sha256").update(canonical).digest("hex");
const parse = (output) => JSON.parse(String(output));
const cli = (args, options = {}) => parse(execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: tmpdir(), ...options }));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "Matrix 指南 空格-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (ref, contents) => { mkdirSync(dirname(join(root, ref)), { recursive: true }); writeFileSync(join(root, ref), contents); };
  for (const ref of [MODULE, GUIDE_PATH, "product.manifest.json", "bundles/geo-growthmatrix/agent-capabilities.json"]) {
    put(ref, readFileSync(join(ROOT, ref)));
  }
  const call = (input = {}) => spawnSync(process.execPath, ["--input-type=module", "-e",
    `import {workbenchGuide} from ${JSON.stringify(pathToFileURL(join(root, MODULE)).href)};try {console.log(JSON.stringify(workbenchGuide(JSON.parse(process.argv[1]))));} catch(error) {console.log(JSON.stringify({code:error.code,message:error.message}));process.exitCode=1;}`,
    JSON.stringify(input)], { cwd: tmpdir(), encoding: "utf8" });
  return { root, put, call };
}

test("empty-input capability returns full canonical UTF-8, identity, version and digest with no network", async () => {
  const catalog = await loadCatalog(ROOT);
  const descriptor = catalog.entries.get(ID);
  assert.equal(descriptor.operation, "read");
  assert.equal(descriptor.risk, "low");
  assert.equal(descriptor.dataMode, "unverified");
  let network = 0;
  const result = await invokeCapability(catalog, ID, {}, { fetcher: () => { network += 1; throw new Error("must remain local"); } });
  assert.equal(network, 0);
  assert.equal(result.status, "succeeded");
  assert.equal(result.dataMode, "unverified");
  assert.equal(result.result.content, canonical.toString("utf8"));
  assert.equal(result.result.bytes, canonical.length);
  assert.equal(result.result.sha256, digest);
  assert.equal(result.result.path, GUIDE_PATH);
  assert.equal(result.result.guideVersion, GUIDE_VERSION);
  assert.equal(result.result.productId, "workloom-ai-growthmatrix");
  assert.equal(result.result.repository, "workloom-ai/WorkLoom-growthmatrix");
  assert.equal(result.result.boundaries.nativeStandardPostAvailable, false);
  assert.equal(result.result.boundaries.providerSuccessDirectPostAvailable, true);
  assert.equal(result.result.boundaries.sourceQualityReviewDefault, false);
  assert.equal(result.result.boundaries.automaticAsrTts, false);
  assert.match(result.result.content, /供应商成功渲染的镜头默认接受/);
  assert.match(result.result.content, /voice 默认沿用成功片段的节目音轨/);
  assert.match(result.result.content, /旧品质分为 0/);
  const tool = mcpTools(catalog).find(entry => entry.name === "workloom_growth_video_workbench_guide");
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.deepEqual(tool.inputSchema, { type: "object", properties: {}, additionalProperties: false });
});

test("CLI list, describe and invoke use the same canonical guide from an unrelated cwd", () => {
  const list = cli(["list"]);
  assert.ok(list.capabilities.some(item => item.id === ID && item.enabled));
  assert.equal(cli(["describe", ID]).transport.export, "workbenchGuide");
  assert.deepEqual(cli(["invoke", ID]).result, workbenchGuide({}));
  const bad = spawnSync(process.execPath, [CLI, "invoke", ID, "--input-file", "-"], { cwd: tmpdir(), input: '{"path":"../private"}', encoding: "utf8" });
  assert.notEqual(bad.status, 0);
  assert.equal(JSON.parse(bad.stderr).error.code, "INVALID_INPUT");
});

test("real stdio MCP initialize, list, call and invalid arguments preserve the same guide", () => {
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "guide-test", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "workloom_growth_video_workbench_guide", arguments: {} } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "workloom_growth_video_workbench_guide", arguments: { path: "other.md" } } },
  ];
  const output = execFileSync(process.execPath, [MCP], { cwd: tmpdir(), env: { ...process.env, WORKLOOM_PRODUCT_ROOT: ROOT },
    input: requests.map(request => JSON.stringify(request)).join("\n") + "\n", encoding: "utf8", timeout: 10_000 });
  const responses = new Map(output.trim().split("\n").map(line => { const value = JSON.parse(line); return [value.id, value.result]; }));
  assert.equal(responses.get(1).serverInfo.name, "workloom-agent");
  assert.ok(responses.get(2).tools.some(item => item.name === "workloom_growth_video_workbench_guide"));
  assert.equal(responses.get(3).isError, false);
  assert.deepEqual(JSON.parse(responses.get(3).content[0].text).result, workbenchGuide({}));
  assert.equal(responses.get(4).isError, true);
  assert.equal(JSON.parse(responses.get(4).content[0].text).error.code, "INVALID_INPUT");
});

test("direct module rejects arrays, primitives, null and every client-selected field", () => {
  for (const input of [null, [], "", 1, true, new Date(), { path: GUIDE_PATH }, { projectId: "P1" }, { secret: "test-only-invalid-input" }]) {
    assert.throws(() => workbenchGuide(input), error => error.code === "GUIDE_INPUT_INVALID");
  }
});

test("production plan points to the discoverable fixed guide before any execution", () => {
  const plan = productionPlan({ projectId: "VID-GUIDE-TEST" });
  assert.equal(plan.previewOnly, true);
  assert.equal(plan.guide.capabilityId, ID);
  assert.equal(plan.guide.path, GUIDE_PATH);
  assert.equal(plan.guide.guideVersion, GUIDE_VERSION);
  assert.equal(plan.guide.requiredBeforeRun, true);
  assert.deepEqual(plan.guide.execution.args, ["scripts/workloom-agent.mjs", "invoke", ID]);
});

test("copied module and doc still work with spaces, Unicode and unrelated cwd", (t) => {
  const { call } = fixture(t);
  const result = call();
  assert.equal(result.status, 0);
  assert.equal(parse(result.stdout).sha256, digest);
  assert.equal(parse(result.stdout).content, canonical.toString("utf8"));
});

test("maximum-sized valid guide is returned fully rather than truncated", (t) => {
  const { put, call } = fixture(t);
  const maximum = Buffer.concat([canonical, Buffer.alloc(512 * 1024 - canonical.length, 0x20)]);
  put(GUIDE_PATH, maximum);
  const output = call();
  assert.equal(output.status, 0);
  assert.equal(parse(output.stdout).bytes, maximum.length);
  assert.equal(parse(output.stdout).content, maximum.toString("utf8"));
  assert.equal(parse(output.stdout).sha256, createHash("sha256").update(maximum).digest("hex"));
});

test("concurrent guide invocations retain independent identical receipts without service calls", async () => {
  const catalog = await loadCatalog(ROOT);
  const results = await Promise.all(Array.from({ length: 4 }, () => invokeCapability(catalog, ID, {}, {
    fetcher: () => { throw new Error("local guide must not call service"); },
  })));
  for (const result of results) assert.deepEqual(result.result, workbenchGuide({}));
  assert.notEqual(results[0], results[1]);
});

for (const [label, change, code] of [
  ["missing guide", ({ root }) => rmSync(join(root, GUIDE_PATH)), "GUIDE_MISSING"],
  ["directory instead of file", ({ root }) => { rmSync(join(root, GUIDE_PATH)); mkdirSync(join(root, GUIDE_PATH)); }, "GUIDE_PATH_INVALID"],
  ["oversized guide", ({ put }) => put(GUIDE_PATH, Buffer.alloc(512 * 1024 + 1)), "GUIDE_TOO_LARGE"],
  ["empty guide", ({ put }) => put(GUIDE_PATH, ""), "GUIDE_INVALID"],
  ["invalid UTF-8", ({ put }) => put(GUIDE_PATH, Buffer.from([0xff, 0xfe])), "GUIDE_INVALID"],
  ["wrong guide version", ({ put }) => put(GUIDE_PATH, canonical.toString("utf8").replace(GUIDE_VERSION, "old-version")), "GUIDE_INVALID"],
  ["wrong product", ({ put }) => put("product.manifest.json", JSON.stringify({ productId: "wrong" })), "GUIDE_PRODUCT_MISMATCH"],
  ["invalid product JSON", ({ put }) => put("product.manifest.json", "{"), "GUIDE_INVALID"],
  ["missing product manifest", ({ root }) => rmSync(join(root, "product.manifest.json")), "GUIDE_MISSING"],
]) {
  test(label + " fails explicitly without a partial success", (t) => {
    const fixtureValue = fixture(t);
    change(fixtureValue);
    const result = fixtureValue.call();
    assert.equal(result.status, 1);
    assert.equal(parse(result.stdout).code, code);
    assert.equal(Object.hasOwn(parse(result.stdout), "content"), false);
  });
}

test("file and directory symlinks cannot expose arbitrary outside text", (t) => {
  for (const ancestor of [false, true]) {
    const value = fixture(t);
    const outside = mkdtempSync(join(tmpdir(), "Matrix guide outside-"));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(join(outside, "ai-video-workbench-guide.md"), "synthetic outside text");
    if (ancestor) {
      rmSync(join(value.root, "docs"), { recursive: true });
      symlinkSync(outside, join(value.root, "docs"), "junction");
    } else {
      rmSync(join(value.root, GUIDE_PATH));
      symlinkSync(join(outside, "ai-video-workbench-guide.md"), join(value.root, GUIDE_PATH));
    }
    const result = value.call();
    assert.equal(result.status, 1);
    assert.equal(parse(result.stdout).code, "GUIDE_PATH_INVALID");
    assert.equal(result.stdout.includes("synthetic outside text"), false);
  }
});

test("old payload reports absent capability; new incomplete payload reports missing guide", (t) => {
  const value = fixture(t);
  const manifestRef = "bundles/geo-growthmatrix/agent-capabilities.json";
  const manifest = JSON.parse(readFileSync(join(value.root, manifestRef)));
  const original = JSON.stringify(manifest);
  manifest.capabilities = manifest.capabilities.filter(item => item.id !== ID);
  value.put(manifestRef, JSON.stringify(manifest));
  let result = spawnSync(process.execPath, [CLI, "invoke", ID, "--root", value.root], { cwd: tmpdir(), encoding: "utf8" });
  assert.equal(JSON.parse(result.stderr).error.code, "NOT_FOUND");
  value.put(manifestRef, original);
  rmSync(join(value.root, GUIDE_PATH));
  result = spawnSync(process.execPath, [CLI, "invoke", ID, "--root", value.root], { cwd: tmpdir(), encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(result.stderr).error.code, "INTERNAL_ERROR");
  assert.match(JSON.parse(result.stderr).error.message, /固定指南依赖缺失/u);
});
