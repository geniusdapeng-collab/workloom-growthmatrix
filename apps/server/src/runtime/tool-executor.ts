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
 *
 * B-65（TECH-15）执行器沙箱与动态加载权限治理（2026-09-24 增补）：
 *  - **路径白名单**：模块必须落在 `WORKLOOM_TOOL_EXECUTOR_ROOTS`（缺省：仓库 bundles/packages/apps
 *    与 .workloom-runtime-deps）之内的 **realpath**；符号链接逃逸（软链指向白名单外）同样拒绝——
 *    动态 import 会把模块当本进程代码执行，路径治理是唯一的加载期边界；
 *  - **工具级权限清单**：模块旁可放 `<模块文件名>.workloom-executor.json` 声明 `{ tools: [...] }`，
 *    声明后该模块只允许执行清单内工具（越权调用 → connector-required + 治理告警，不伪造回执）；
 *  - 治理拒绝一律 fail-closed：不 import、不执行、返回未核实，并留 console 审计行。
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
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

export class ExecutorGovernanceError extends Error {
  constructor(public readonly code: "OUT_OF_ROOT" | "BAD_MANIFEST", message: string) {
    super(message);
    this.name = "ExecutorGovernanceError";
  }
}

/** 执行器模块白名单根（逗号分隔；相对路径按 cwd 解析）；未配置时取仓库缺省根 */
export function executorAllowedRoots(env: Record<string, string | undefined> = process.env): string[] {
  const raw = (env.WORKLOOM_TOOL_EXECUTOR_ROOTS ?? "").trim();
  const entries = raw
    ? raw.split(",").map((s) => s.trim()).filter(Boolean)
    : ["bundles", "packages", "apps", ".workloom-runtime-deps"];
  return entries.map((entry) => {
    const absolute = isAbsolute(entry) ? entry : resolve(process.cwd(), entry);
    try {
      return realpathSync(absolute);
    } catch {
      return absolute; // 不存在的根：保留字面值，比较时自然不命中
    }
  });
}

/**
 * 校验模块路径是否在白名单根内（按 realpath，堵住软链逃逸）。
 * 目标文件不存在 / 解析失败 → 同样拒绝（fail-closed）。
 */
export function assertExecutorModuleAllowed(modulePath: string, roots: string[]): string {
  let realModule: string;
  try {
    realModule = realpathSync(modulePath);
  } catch {
    throw new ExecutorGovernanceError("OUT_OF_ROOT", `执行器模块不可解析（不存在或不可读）：${modulePath}`);
  }
  const allowed = roots.some((root) => {
    const realRoot = (() => { try { return realpathSync(root); } catch { return root; } })();
    return realModule === realRoot || realModule.startsWith(realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`);
  });
  if (!allowed) {
    throw new ExecutorGovernanceError("OUT_OF_ROOT",
      `执行器模块不在白名单根内（B-65）：${realModule}（允许根：${roots.join(" · ")}）`);
  }
  return realModule;
}

/** 模块权限清单（可选）：声明后按工具名白名单执行 */
export interface ExecutorManifest {
  name?: string;
  prefix?: string;
  /** 允许该模块执行的工具名（精确名）；缺省=不限制（兼容既有桥） */
  tools?: string[];
}

export function manifestPathOf(modulePath: string): string {
  return join(dirname(modulePath), `${modulePath.split(sep).pop()}.workloom-executor.json`);
}

/** 读取模块权限清单；文件缺失返回 null；内容非法抛 BAD_MANIFEST（fail-closed） */
export function readExecutorManifest(modulePath: string): ExecutorManifest | null {
  const file = manifestPathOf(modulePath);
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8"));
  } catch (error) {
    throw new ExecutorGovernanceError("BAD_MANIFEST", `执行器清单不是合法 JSON：${file}（${error instanceof Error ? error.message : String(error)}）`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ExecutorGovernanceError("BAD_MANIFEST", `执行器清单必须是对象：${file}`);
  }
  const doc = parsed as { tools?: unknown; name?: unknown; prefix?: unknown };
  if (doc.tools !== undefined && (!Array.isArray(doc.tools) || doc.tools.some((t) => typeof t !== "string" || !t.trim()))) {
    throw new ExecutorGovernanceError("BAD_MANIFEST", `执行器清单 tools 必须是字符串数组：${file}`);
  }
  return {
    ...(typeof doc.name === "string" ? { name: doc.name } : {}),
    ...(typeof doc.prefix === "string" ? { prefix: doc.prefix } : {}),
    ...(Array.isArray(doc.tools) ? { tools: doc.tools as string[] } : {}),
  };
}

/** 工具级权限判定：无清单或未声明 tools → 放行；声明后只允许清单内工具 */
export function checkExecutorToolPermission(
  manifest: ExecutorManifest | null, toolName: string,
): { ok: true } | { ok: false; reason: string } {
  if (!manifest?.tools) return { ok: true };
  return manifest.tools.includes(toolName)
    ? { ok: true }
    : { ok: false, reason: `模块「${manifest.name ?? manifest.tools.join("/")}」未授权工具 ${toolName}（清单 tools 白名单）` };
}

interface ModuleShape {
  createToolExecutorForScope?: (scope?: Partial<Scope>) => DeploymentToolExecutor | undefined;
  createToolExecutor?: () => DeploymentToolExecutor | undefined;
}

const routeCache = new Map<string, { mod?: ModuleShape; error?: string }>();

/** B-65：模块级清单缓存（按 realpath） */
const manifestCache = new Map<string, { manifest: ExecutorManifest | null; error?: string }>();

function loadManifest(modulePath: string): ExecutorManifest | null {
  const hit = manifestCache.get(modulePath);
  if (hit) return hit.manifest;
  try {
    const manifest = readExecutorManifest(modulePath);
    manifestCache.set(modulePath, { manifest });
    return manifest;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[tool-executor] 执行器清单非法（fail-closed：该模块整体拒绝加载）", modulePath, message);
    manifestCache.set(modulePath, { manifest: null, error: message });
    return null;
  }
}

async function loadRouteModule(route: ToolExecutorRoute): Promise<ModuleShape | undefined> {
  const hit = routeCache.get(route.modulePath);
  if (hit) return hit.mod;
  // B-65 沙箱：路径白名单（realpath）——不在允许根的模块一律不 import
  try {
    assertExecutorModuleAllowed(route.modulePath, executorAllowedRoots());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[tool-executor] 模块路径治理拒绝（B-65，fail-closed）", route.modulePath, message);
    routeCache.set(route.modulePath, { error: message });
    return undefined;
  }
  // B-65 权限清单：清单非法时该模块整体拒绝（不"部分放行"）
  loadManifest(route.modulePath); // 结果进缓存，执行期按工具名判定；此处只为触发校验
  if (manifestCache.get(route.modulePath)?.error) return undefined;
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
    // B-65 工具级权限：清单声明 tools 白名单后，越权调用拒绝执行（不伪造回执）
    const manifest = routeCache.get(route.modulePath)?.error ? null : loadManifest(route.modulePath);
    const permission = checkExecutorToolPermission(manifest, name);
    if (!permission.ok) {
      console.error("[tool-executor] 工具级权限拒绝（B-65，fail-closed）", route.modulePath, permission.reason);
      return connectorRequired(name);
    }
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
