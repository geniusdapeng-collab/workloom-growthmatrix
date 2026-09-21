/**
 * ota-bridge · OTA 素材执行器适配器（B-22 + B-19）
 *
 * 与发布/信源不同，OTA 商家后台是标准 HTTP API，无需浏览器工位：
 * 本适配器直接把 `ota.asset.upload` 映射到 @workloom/base/ota-publisher 的三通道适配器。
 * 未配置通道凭证 → 回执 synced=false（fail-closed）；审核状态由回执探测回写。
 */
import { OtaAssetSchema, createOtaAdapter } from "@workloom/base/ota-publisher";

const connectorRequired = (name: string) => ({
  result: { state: "connector-required", tool: name },
  receipt: { synced: false },
});

export function createToolExecutorForScope() {
  return async (name: string, params: Record<string, unknown>) => {
    if (name !== "ota.asset.upload") return connectorRequired(name);
    const raw = (params.asset && typeof params.asset === "object") ? params.asset : params;
    const parsed = OtaAssetSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        result: { state: "invalid-input", tool: name, issues: parsed.error.issues.slice(0, 5).map((i) => i.message) },
        receipt: { synced: false },
      };
    }
    const receipt = await createOtaAdapter(parsed.data.channel).upload(parsed.data);
    return {
      result: { state: receipt.status, receipt },
      receipt: {
        synced: receipt.synced,
        ...(receipt.evidenceUri ? { snapshot_uri: receipt.evidenceUri } : {}),
        ...(receipt.verifiedAt ? { verified_at: receipt.verifiedAt } : {}),
      },
    };
  };
}
