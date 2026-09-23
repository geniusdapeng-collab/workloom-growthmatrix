/**
 * B-21 多执行器组合测试：前缀路由、最长匹配、兜底、单模块失败隔离（fail-closed 不伪造回执）。
 * B-65 执行器沙箱测试：路径白名单（含软链逃逸）、工具级权限清单、非法清单整体拒绝。
 */
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertExecutorModuleAllowed, checkExecutorToolPermission, ExecutorGovernanceError, executorAllowedRoots,
  loadDeploymentToolExecutor, parseToolExecutorRoutes, readExecutorManifest, resolveToolRoute, type ToolExecutorRoute,
} from "./tool-executor.js";

const originalModules = process.env.WORKLOOM_TOOL_EXECUTOR_MODULES;
const originalSingle = process.env.WORKLOOM_TOOL_EXECUTOR_MODULE;
const originalRoots = process.env.WORKLOOM_TOOL_EXECUTOR_ROOTS;

afterEach(() => {
  if (originalModules === undefined) delete process.env.WORKLOOM_TOOL_EXECUTOR_MODULES;
  else process.env.WORKLOOM_TOOL_EXECUTOR_MODULES = originalModules;
  if (originalSingle === undefined) delete process.env.WORKLOOM_TOOL_EXECUTOR_MODULE;
  else process.env.WORKLOOM_TOOL_EXECUTOR_MODULE = originalSingle;
  if (originalRoots === undefined) delete process.env.WORKLOOM_TOOL_EXECUTOR_ROOTS;
  else process.env.WORKLOOM_TOOL_EXECUTOR_ROOTS = originalRoots;
});

describe("B-21 配置解析", () => {
  it("逗号列表 + 前缀路由；不带前缀为兜底；旧单模块变量兼容", () => {
    expect(parseToolExecutorRoutes({ WORKLOOM_TOOL_EXECUTOR_MODULES: "visual=/a.mjs, publish=/b.mjs, /legacy.mjs" }))
      .toEqual([
        { prefix: "visual", modulePath: "/a.mjs" },
        { prefix: "publish", modulePath: "/b.mjs" },
        { prefix: null, modulePath: "/legacy.mjs" },
      ]);
    expect(parseToolExecutorRoutes({ WORKLOOM_TOOL_EXECUTOR_MODULE: "/only.mjs" }))
      .toEqual([{ prefix: null, modulePath: "/only.mjs" }]);
    expect(parseToolExecutorRoutes({ WORKLOOM_TOOL_EXECUTOR_MODULES: "bad prefix=/x.mjs,/ok.mjs" }))
      .toEqual([{ prefix: null, modulePath: "/ok.mjs" }]);
  });
});

describe("B-21 路由选择（纯函数）", () => {
  const routes: ToolExecutorRoute[] = [
    { prefix: "visual", modulePath: "/visual.mjs" },
    { prefix: "publish", modulePath: "/publish.mjs" },
    { prefix: null, modulePath: "/fallback.mjs" },
  ];

  it("前缀命中优先，未命中回退兜底", () => {
    expect(resolveToolRoute("visualwrite.compose", routes)?.modulePath).toBe("/visual.mjs");
    expect(resolveToolRoute("publish.dispatch", routes)?.modulePath).toBe("/publish.mjs");
    expect(resolveToolRoute("colorwrite.best", routes)?.modulePath).toBe("/fallback.mjs");
  });

  it("最长前缀优先；只有前缀路由且不命中 → undefined（不误派）", () => {
    const multi: ToolExecutorRoute[] = [
      { prefix: "pub", modulePath: "/pub.mjs" },
      { prefix: "publish", modulePath: "/publish.mjs" },
    ];
    expect(resolveToolRoute("publish.dispatch", multi)?.modulePath).toBe("/publish.mjs");
    expect(resolveToolRoute("unknown.tool", multi)).toBeUndefined();
  });
});

describe("B-21 组合执行器（真实模块加载 + 失败隔离）", () => {
  it("多模块按前缀路由；损坏模块只影响自身路由；无命中返回 connector-required", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wl-exec-"));
    const moduleOf = (marker: string, throwAtCall = false) => `
      export function createToolExecutor() {
        return async (name, params) => {
          ${throwAtCall ? 'throw new Error("boom");' : ""}
          return { result: { state: "${marker}", name }, receipt: { synced: true, snapshot_uri: "test://${marker}" } };
        };
      }`;
    const visualPath = join(dir, "visual.mjs");
    const publishPath = join(dir, "publish.mjs");
    writeFileSync(visualPath, moduleOf("visual"));
    writeFileSync(publishPath, moduleOf("publish", true));
    process.env.WORKLOOM_TOOL_EXECUTOR_MODULES = `visual=${visualPath},publish=${publishPath},broken=${join(dir, "missing.mjs")}`;
    delete process.env.WORKLOOM_TOOL_EXECUTOR_MODULE;
    // B-65：临时目录不在缺省白名单内，显式把它加进允许根（真实部署同样用法）
    process.env.WORKLOOM_TOOL_EXECUTOR_ROOTS = dir;

    const executor = await loadDeploymentToolExecutor({ tenantId: "tenant-demo", workspaceId: "ws-test" });
    expect(executor).toBeTruthy();

    const visual = await executor!("visualwrite.compose", {});
    expect(visual.receipt.synced).toBe(true);
    expect(visual.result.state).toBe("visual");

    // publish 模块工厂成功但调用抛错 → 该工具按未核实处理，不伪造回执
    const publish = await executor!("publish.dispatch", {});
    expect(publish.receipt.synced).toBe(false);
    expect(publish.result.state).toBe("connector-required");

    // broken 路由模块不存在 → 只影响 broken.*
    const broken = await executor!("broken.tool", {});
    expect(broken.receipt.synced).toBe(false);

    // 未命中任何路由且无兜底 → connector-required（不误派给视觉模块）
    const unknown = await executor!("unknown.tool", {});
    expect(unknown.result.state).toBe("connector-required");
    expect(unknown.result.tool).toBe("unknown.tool");

    // 模块缓存后视觉路由仍可用（单模块失败不影响其他模块）
    expect((await executor!("visualwrite.compose", {})).result.state).toBe("visual");
  });

  it("未配置任何模块 → undefined（保持 executeDeclaredTool 原语义）", async () => {
    delete process.env.WORKLOOM_TOOL_EXECUTOR_MODULES;
    delete process.env.WORKLOOM_TOOL_EXECUTOR_MODULE;
    expect(await loadDeploymentToolExecutor({ tenantId: "t", workspaceId: "w" })).toBeUndefined();
  });
});

describe("B-65 执行器沙箱与动态加载权限治理", () => {
  it("路径白名单：根内放行；根外拒绝；软链逃逸拒绝（realpath 判定）", () => {
    const root = mkdtempSync(join(tmpdir(), "wl-exec-root-"));
    const outside = mkdtempSync(join(tmpdir(), "wl-exec-out-"));
    const inside = join(root, "ok.mjs");
    const outsideModule = join(outside, "evil.mjs");
    writeFileSync(inside, "export {};\n");
    writeFileSync(outsideModule, "export {};\n");
    // macOS /var → /private/var 软链：返回值按 realpath 归一
    expect(assertExecutorModuleAllowed(inside, [root])).toBe(realpathSync(inside));
    expect(() => assertExecutorModuleAllowed(outsideModule, [root]))
      .toThrowError(ExecutorGovernanceError);
    // 软链逃逸：根内的链接指向根外 → 按 realpath 拒绝
    const escape = join(root, "escape.mjs");
    symlinkSync(outsideModule, escape);
    expect(() => assertExecutorModuleAllowed(escape, [root])).toThrow(/白名单/);
    // 目标不存在 → 同样拒绝（fail-closed）
    expect(() => assertExecutorModuleAllowed(join(root, "missing.mjs"), [root])).toThrow(/不可解析/);
  });

  it("权限清单：缺失=不限制；非法 JSON / tools 非数组 → BAD_MANIFEST；声明后按工具名放行", () => {
    const dir = mkdtempSync(join(tmpdir(), "wl-exec-manifest-"));
    const mod = join(dir, "bridge.mjs");
    writeFileSync(mod, "export {};\n");
    expect(readExecutorManifest(mod)).toBeNull();
    expect(checkExecutorToolPermission(null, "anything.write").ok).toBe(true);

    const manifestFile = join(dir, "bridge.mjs.workloom-executor.json");
    writeFileSync(manifestFile, "{ not json ");
    expect(() => readExecutorManifest(mod)).toThrow(/合法 JSON/);
    writeFileSync(manifestFile, JSON.stringify({ name: "视觉桥", tools: "visualwrite" }));
    expect(() => readExecutorManifest(mod)).toThrow(/字符串数组/);

    writeFileSync(manifestFile, JSON.stringify({ name: "视觉桥", tools: ["visualwrite.compose"] }));
    const manifest = readExecutorManifest(mod);
    expect(manifest).toMatchObject({ name: "视觉桥" });
    expect(checkExecutorToolPermission(manifest, "visualwrite.compose").ok).toBe(true);
    const denied = checkExecutorToolPermission(manifest, "visualwrite.render");
    expect(denied.ok).toBe(false);
    expect(denied.ok === false && denied.reason).toContain("未授权工具");
  });

  it("越权模块拒绝执行：根外模块不加载；清单外的工具调用返回未核实（不伪造回执）", async () => {
    const root = mkdtempSync(join(tmpdir(), "wl-exec-allowed-"));
    const outside = mkdtempSync(join(tmpdir(), "wl-exec-out2-"));
    const moduleSource = `
      export function createToolExecutor() {
        return async (name) => ({ result: { state: "done", tool: name }, receipt: { synced: true, snapshot_uri: "uri://x" } });
      }`;
    const allowedModule = join(root, "allowed.mjs");
    const outsideModule = join(outside, "outside.mjs");
    writeFileSync(allowedModule, moduleSource);
    writeFileSync(outsideModule, moduleSource);
    writeFileSync(join(root, "allowed.mjs.workloom-executor.json"), JSON.stringify({ name: "白名单桥", tools: ["visualwrite.compose"] }));
    process.env.WORKLOOM_TOOL_EXECUTOR_ROOTS = root;
    process.env.WORKLOOM_TOOL_EXECUTOR_MODULES = `visual=${allowedModule},outside=${outsideModule}`;
    delete process.env.WORKLOOM_TOOL_EXECUTOR_MODULE;

    const executor = await loadDeploymentToolExecutor({ tenantId: "t", workspaceId: "w" });
    expect(executor).toBeTruthy();
    // 清单内工具：正常执行
    expect((await executor!("visualwrite.compose", {})).receipt.synced).toBe(true);
    // 清单外工具：拒绝执行（connector-required，不伪造回执）
    const denied = await executor!("visualwrite.render", {});
    expect(denied.receipt.synced).toBe(false);
    expect(denied.result.state).toBe("connector-required");
    // 根外模块：整条路由不加载
    const blocked = await executor!("outside.anything", {});
    expect(blocked.receipt.synced).toBe(false);
    expect(blocked.result.state).toBe("connector-required");
  });

  it("allowedRoots 缺省覆盖仓库目录，显式配置按逗号列表覆盖", () => {
    const defaults = executorAllowedRoots({});
    expect(defaults.length).toBeGreaterThanOrEqual(3);
    expect(defaults.some((r) => r.endsWith(`${sepForTest()}bundles`))).toBe(true);
    const custom = executorAllowedRoots({ WORKLOOM_TOOL_EXECUTOR_ROOTS: "/tmp/a, /tmp/b" });
    expect(custom).toEqual(["/tmp/a", "/tmp/b"]);
  });
});

/** 平台分隔符（Windows 兼容的测试辅助） */
function sepForTest(): string {
  return process.platform === "win32" ? "\\" : "/";
}
