/**
 * source-bridge · 信源执行器桥（B-22）
 *
 * 知乎/头条/百家号/公众号/微博等信源发布走工位机浏览器通道；服务端只经桥调用。
 * 未配置 → undefined（connector-required），无回执不宣称完成。
 */
import { bridgeConfigFromEnv, createHttpBridgeExecutor } from "@workloom/base/bridge-client";

export function createToolExecutorForScope(scope?: { tenantId?: string; workspaceId?: string }) {
  const cfg = bridgeConfigFromEnv("WORKLOOM_SOURCE_BRIDGE_URL", "WORKLOOM_SOURCE_BRIDGE_TOKEN");
  if (!cfg) return undefined;
  return createHttpBridgeExecutor({
    ...cfg,
    scope: { tenantId: scope?.tenantId ?? "", workspaceId: scope?.workspaceId ?? "" },
    timeoutMs: Number(process.env.WORKLOOM_SOURCE_BRIDGE_TIMEOUT_MS ?? 60_000),
  });
}
