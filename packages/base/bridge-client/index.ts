/**
 * bridge-client —— 执行器桥通用客户端（B-20/B-22）
 *
 * 场景：发布/信源/私域三类执行器的真实实现跑在「工位机/桌面包」侧（浏览器登录态、Playwright、
 * 企微 API 代理等），服务端通过一个受控 HTTP 桥调用。桥的契约固定：
 *   POST {baseUrl}/tools/execute
 *   Authorization: Bearer <token>
 *   { tool, params, scope: { tenantId, workspaceId } }
 *   → { result, receipt: { synced, snapshot_uri?, verified_at? } }
 *
 * 纪律（与 tool-executor 同口径）：
 *  - 未配置 URL/Token → 返回 undefined（宿主按 connector-required 处理，不伪造回执）；
 *  - 桥不可达/超时/非 2xx/回执缺失 → 返回 `{result:{state:"connector-required"},receipt:{synced:false}}`；
 *  - 一切请求带超时与一次重试（幂等键由调用方 params 携带）。
 */

export interface BridgeScope {
  tenantId: string;
  workspaceId: string;
}

export interface BridgeToolResult {
  result: Record<string, unknown>;
  receipt: { synced: boolean; snapshot_uri?: string; verified_at?: string };
}

export type BridgeToolExecutor = (name: string, params: Record<string, unknown>) => Promise<BridgeToolResult>;

export interface BridgeClientOptions {
  baseUrl: string;
  token: string;
  scope: BridgeScope;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const connectorRequired = (name: string): BridgeToolResult => ({
  result: { state: "connector-required", tool: name },
  receipt: { synced: false },
});

/** 从环境变量解析桥配置；缺任一 → undefined（fail-closed，不降级 mock）。 */
export function bridgeConfigFromEnv(
  urlKey: string, tokenKey: string, env: Record<string, string | undefined> = process.env,
): { baseUrl: string; token: string } | undefined {
  const baseUrl = env[urlKey]?.trim().replace(/\/$/, "") ?? "";
  const token = env[tokenKey]?.trim() ?? "";
  return baseUrl && token ? { baseUrl, token } : undefined;
}

export function createHttpBridgeExecutor(opts: BridgeClientOptions): BridgeToolExecutor {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return async (name, params) => {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`${opts.baseUrl}/tools/execute`, {
          method: "POST",
          headers: { authorization: `Bearer ${opts.token}`, "content-type": "application/json" },
          body: JSON.stringify({ tool: name, params, scope: opts.scope }),
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!response.ok) {
          if (response.status >= 500 && attempt === 1) continue;
          return { ...connectorRequired(name), result: { state: "connector-required", tool: name, httpStatus: response.status } };
        }
        const body = await response.json().catch(() => null) as
          | { result?: Record<string, unknown>; receipt?: { synced?: boolean; snapshot_uri?: string; verified_at?: string } }
          | null;
        if (!body || typeof body !== "object" || typeof body.receipt?.synced !== "boolean") {
          return connectorRequired(name);
        }
        return {
          result: body.result ?? {},
          receipt: {
            synced: body.receipt.synced,
            ...(body.receipt.snapshot_uri ? { snapshot_uri: body.receipt.snapshot_uri } : {}),
            ...(body.receipt.verified_at ? { verified_at: body.receipt.verified_at } : {}),
          },
        };
      } catch {
        clearTimeout(timer);
        if (attempt === 1) continue;
      }
    }
    return connectorRequired(name);
  };
}
