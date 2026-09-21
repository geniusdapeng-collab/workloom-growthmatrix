/**
 * 部署层 ToolExecutor 注入 seam（growth 实验车道先行；基座提案 0001 的本地版本）。
 *
 * 背景：`runQuest` 已预留 `input.toolExecutor`，但宿主没有注入点——真实连接器（视觉工位 bridge、
 * 发布 RPA 等）无法进入 Quest 步骤执行，步骤只能落 `executeDeclaredTool` 兜底（真实数据态返回
 * `connector-required` 且不回执），于是"让 AI 生成一张图"只会立项、不会出图。
 *
 * 口径（与提案一致，fail-closed）：
 *  - `WORKLOOM_TOOL_EXECUTOR_MODULES` 支持逗号列表与 `前缀=路径` 路由（B-21）：
 *      视觉=/abs/visual-bridge.mts,发布=/abs/publish-bridge.mts,私域=/abs/private-domain-bridge.mts
 *    未带前缀的条目为兜底路由；旧的 `WORKLOOM_TOOL_EXECUTOR_MODULE` 仍兼容（等价单条兜底）；
 *  - 模块导出 `createToolExecutorForScope(scope)`（或 `createToolExecutor()`）；
 *  - 路由按工具名前缀最长匹配；命中模块导入失败/工厂抛错/执行抛错 → 该工具返回
 *    `connector-required`（synced=false，绝不伪造回执），**不影响其他模块**；
 *  - 未配置任何模块 → 返回 undefined（调用方保持 executeDeclaredTool 原语义）；
 *  - 模块按路径缓存；错误只落服务端日志，不向客户端泄露路径细节。
 */
import { pathToFileURL } from "node:url";
import {
  parseToolExecutorRoutes,
  resolveToolRoute,
  type ToolExecutorRoute,
} from "@workloom/base/publish-rpa";

// B-21 路由纯函数下沉 base（scripts/connectors-check 与宿主共用同一实现）
export { parseToolExecutorRoutes, resolveToolRoute, type ToolExecutorRoute };

export interface DeploymentToolResult {
  result: Record<string, unknown>;
  receipt: { synced: boolean; snapshot_uri?: string; verified_at?: string };
}

export type DeploymentToolExecutor = (
  name: string,
  params: Record<string, unknown>,
) => Promise<DeploymentToolResult>;

type Scope = { tenantId: string; workspaceId: string };

interface ModuleShape {
  createToolExecutorForScope?: (scope?: Partial<Scope>) => DeploymentToolExecutor | undefined;
  createToolExecutor?: () => DeploymentToolExecutor | undefined;
}

const routeCache = new Map<string, { mod?: ModuleShape; error?: string }>();

async function loadRouteModule(route: ToolExecutorRoute): Promise<ModuleShape | undefined> {
  const hit = routeCache.get(route.modulePath);
  if (hit) return hit.mod;
  try {
    const mod = (await import(pathToFileURL(route.modulePath).href)) as ModuleShape;
    routeCache.set(route.modulePath, { mod });
    return mod;
  } catch (error) {
    console.error(
      "[tool-executor] 执行器模块加载失败（fail-closed：该路由按未核实处理，其他模块不受影响）",
      route.modulePath,
      error instanceof Error ? error.message : String(error),
    );
    routeCache.set(route.modulePath, { error: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

const connectorRequired = (name: string): DeploymentToolResult => ({
  result: { state: "connector-required", tool: name },
  receipt: { synced: false },
});

export async function loadDeploymentToolExecutor(scope: Scope): Promise<DeploymentToolExecutor | undefined> {
  const routes = parseToolExecutorRoutes();
  if (routes.length === 0) return undefined;
  // 预加载（并行）：单模块失败只记录，不影响其他模块
  const loaded = new Map<string, DeploymentToolExecutor | undefined>();
  await Promise.all(routes.map(async (route) => {
    const mod = await loadRouteModule(route);
    const factory = mod?.createToolExecutorForScope ?? mod?.createToolExecutor;
    if (!factory) return;
    try {
      loaded.set(route.modulePath, factory({ tenantId: scope.tenantId, workspaceId: scope.workspaceId }) ?? undefined);
    } catch (error) {
      console.error(
        "[tool-executor] 执行器工厂抛错（fail-closed：该路由按未核实处理）",
        route.modulePath,
        error instanceof Error ? error.message : String(error),
      );
    }
  }));
  if ([...loaded.values()].every((executor) => executor === undefined)) return undefined;
  return async (name, params) => {
    const route = resolveToolRoute(name, routes);
    if (!route) return connectorRequired(name);
    const executor = loaded.get(route.modulePath);
    if (!executor) return connectorRequired(name);
    try {
      return await executor(name, params);
    } catch (error) {
      console.error(
        "[tool-executor] 工具执行失败（fail-closed：按未核实处理，不伪造回执）",
        name,
        error instanceof Error ? error.message : String(error),
      );
      return connectorRequired(name);
    }
  };
}
