/**
 * B-21 多执行器组合测试：前缀路由、最长匹配、兜底、单模块失败隔离（fail-closed 不伪造回执）。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadDeploymentToolExecutor, parseToolExecutorRoutes, resolveToolRoute, type ToolExecutorRoute,
} from "./tool-executor.js";

const originalModules = process.env.WORKLOOM_TOOL_EXECUTOR_MODULES;
const originalSingle = process.env.WORKLOOM_TOOL_EXECUTOR_MODULE;

afterEach(() => {
  if (originalModules === undefined) delete process.env.WORKLOOM_TOOL_EXECUTOR_MODULES;
  else process.env.WORKLOOM_TOOL_EXECUTOR_MODULES = originalModules;
  if (originalSingle === undefined) delete process.env.WORKLOOM_TOOL_EXECUTOR_MODULE;
  else process.env.WORKLOOM_TOOL_EXECUTOR_MODULE = originalSingle;
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
