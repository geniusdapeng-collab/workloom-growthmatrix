/**
 * publish-rpa/tool-contract —— 工具调用统一超时/重试/幂等键规范（B-57）
 *
 * 所有执行器（桥/工位/连接器）必须经本包装：
 *  - 幂等键 = sha256(scope|tool|canonical(params))，重复调用可安全重放；
 *  - 超时 + 重试次数按工具族默认值，调用方可覆盖；
 *  - 失败返回 `{result:{state:"connector-required"},receipt:{synced:false}}`，绝不伪造回执。
 */
import { createHash } from "node:crypto";

export interface ToolContractOptions {
  scope: { tenantId: string; workspaceId: string };
  timeoutMs?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ToolContractResult {
  result: Record<string, unknown>;
  receipt: { synced: boolean; snapshot_uri?: string; verified_at?: string };
}

export const TOOL_DEFAULT_TIMEOUT_MS = 30_000;
export const TOOL_DEFAULT_RETRIES = 2;

/** 稳定性序列化：对象键排序后 JSON，保证同参数同键。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}

export function toolIdempotencyKey(
  scope: { tenantId: string; workspaceId: string }, tool: string, params: Record<string, unknown>,
): string {
  return createHash("sha256")
    .update(`${scope.tenantId}|${scope.workspaceId}|${tool}|${canonicalJson(params)}`)
    .digest("hex")
    .slice(0, 32);
}

const connectorRequired = (tool: string): ToolContractResult => ({
  result: { state: "connector-required", tool },
  receipt: { synced: false },
});

export async function withToolContract(
  tool: string,
  params: Record<string, unknown>,
  fn: (params: Record<string, unknown> & { idempotencyKey: string }) => Promise<ToolContractResult>,
  opts: ToolContractOptions,
): Promise<ToolContractResult> {
  const timeoutMs = opts.timeoutMs ?? TOOL_DEFAULT_TIMEOUT_MS;
  const retries = Math.max(0, opts.retries ?? TOOL_DEFAULT_RETRIES);
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const idempotencyKey = toolIdempotencyKey(opts.scope, tool, params);
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await Promise.race([
        fn({ ...params, idempotencyKey }),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(new Error(`工具 ${tool} 超时（${timeoutMs}ms）`)), { once: true });
        }),
      ]);
      clearTimeout(timer);
      return result;
    } catch {
      clearTimeout(timer);
      if (attempt < retries) await sleep(Math.min(2_000, 100 * 2 ** attempt));
    }
  }
  return connectorRequired(tool);
}
