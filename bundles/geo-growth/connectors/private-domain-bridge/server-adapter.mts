/**
 * private-domain-bridge · 私域执行器桥（B-20）
 *
 * 企业微信 API 优先、朋友圈/社群桌面 RPA 兜底——两条路径都由工位侧桥统一暴露
 * （服务端不直接持有企微 secret，只在桥侧配置）。发送回执与频率围栏由桥侧运行；
 * 服务端校验回执形状（synced 必须显式布尔），无回执不宣称完成。
 */
import { bridgeConfigFromEnv, createHttpBridgeExecutor } from "@workloom/base/bridge-client";

export function createToolExecutorForScope(scope?: { tenantId?: string; workspaceId?: string }) {
  const cfg = bridgeConfigFromEnv("WORKLOOM_PRIVATE_DOMAIN_BRIDGE_URL", "WORKLOOM_PRIVATE_DOMAIN_BRIDGE_TOKEN");
  if (!cfg) return undefined;
  return createHttpBridgeExecutor({
    ...cfg,
    scope: { tenantId: scope?.tenantId ?? "", workspaceId: scope?.workspaceId ?? "" },
    timeoutMs: Number(process.env.WORKLOOM_PRIVATE_DOMAIN_BRIDGE_TIMEOUT_MS ?? 30_000),
  });
}
