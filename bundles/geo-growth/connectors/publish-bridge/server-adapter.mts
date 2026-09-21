/**
 * publish-bridge · 发布执行器桥（B-22）
 *
 * 真实浏览器登录态与 Playwright 跑在桌面包/工位机；服务端经 HTTP 桥调用（契约见
 * @workloom/base/bridge-client）。未配置 URL/Token → 返回 undefined，宿主按
 * connector-required 处理（绝不伪造发布回执）。
 */
import { bridgeConfigFromEnv, createHttpBridgeExecutor } from "@workloom/base/bridge-client";

export function createToolExecutorForScope(scope?: { tenantId?: string; workspaceId?: string }) {
  const cfg = bridgeConfigFromEnv("WORKLOOM_PUBLISH_BRIDGE_URL", "WORKLOOM_PUBLISH_BRIDGE_TOKEN");
  if (!cfg) return undefined;
  return createHttpBridgeExecutor({
    ...cfg,
    scope: { tenantId: scope?.tenantId ?? "", workspaceId: scope?.workspaceId ?? "" },
    timeoutMs: Number(process.env.WORKLOOM_PUBLISH_BRIDGE_TIMEOUT_MS ?? 60_000),
  });
}
