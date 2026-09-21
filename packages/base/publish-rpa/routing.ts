/**
 * publish-rpa/routing —— 多执行器路由（B-21 纯函数部分）
 *
 * 配置：`WORKLOOM_TOOL_EXECUTOR_MODULES=[前缀=]绝对路径[, ...]`；
 * 兼容旧变量 `WORKLOOM_TOOL_EXECUTOR_MODULE`（等价单条兜底路由）。
 * 路由规则：按工具名前缀「最长匹配优先」，未命中回退兜底路由；无命中返回 undefined（不误派）。
 */

export interface ToolExecutorRoute {
  /** 工具名前缀（如 visual / publish / private）；null = 兜底路由 */
  prefix: string | null;
  modulePath: string;
}

const PREFIX_RE = /^[a-z][a-z0-9_-]{0,39}$/i;

export function parseToolExecutorRoutes(env: Record<string, string | undefined> = process.env): ToolExecutorRoute[] {
  const raw = (env.WORKLOOM_TOOL_EXECUTOR_MODULES ?? "").trim();
  const legacy = (env.WORKLOOM_TOOL_EXECUTOR_MODULE ?? "").trim();
  const entries = raw
    ? raw.split(",").map((s) => s.trim()).filter(Boolean)
    : legacy ? [legacy] : [];
  const routes: ToolExecutorRoute[] = [];
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    if (eq > 0) {
      const prefix = entry.slice(0, eq).trim();
      const modulePath = entry.slice(eq + 1).trim();
      if (PREFIX_RE.test(prefix) && modulePath) {
        routes.push({ prefix: prefix.toLowerCase(), modulePath });
        continue;
      }
      // 形如 `前缀=路径` 但前缀/路径非法 → 跳过该条（配置错误不静默降级成兜底路由）
      console.error("[tool-executor] 忽略非法路由配置（期望 `前缀=绝对路径`）", entry);
      continue;
    }
    routes.push({ prefix: null, modulePath: entry });
  }
  return routes;
}

/** 工具名前缀：`visualwrite.compose` → visualwrite。 */
export function toolPrefixOf(name: string): string {
  const dot = name.indexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name).toLowerCase();
}

/**
 * 纯函数路由：前缀最长匹配优先；无命中时回退到兜底路由（按声明顺序）。
 * 路由前缀按「工具前缀 startsWith 路由前缀」匹配（如 visual 路由覆盖 visualwrite.*）。
 */
export function resolveToolRoute(name: string, routes: ToolExecutorRoute[]): ToolExecutorRoute | undefined {
  const prefix = toolPrefixOf(name);
  const matched = routes
    .filter((r) => r.prefix !== null && prefix.startsWith(r.prefix))
    .sort((a, b) => (b.prefix!.length - a.prefix!.length) || routes.indexOf(a) - routes.indexOf(b))[0];
  return matched ?? routes.find((r) => r.prefix === null);
}
