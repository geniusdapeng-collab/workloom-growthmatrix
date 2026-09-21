/**
 * workdata/delivery-mode —— mock / live / simulated 三态标识统一（B-55）
 *
 * 纪律（不变量 9：演示与真实能力分明）：
 *  - 任何对外可见的产出/回执必须显式带三态之一；缺失即视为治理缺陷（fail-closed）；
 *  - 投影、战报、UI 与事件同口径，禁止一处 live 一处 mock。
 */

export const DELIVERY_MODES = ["mock", "live", "simulated"] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

export const MODE_LABEL: Record<DeliveryMode, string> = {
  mock: "演示数据（mock）",
  live: "真实数据（live）",
  simulated: "模拟运行态（simulated）",
};

const CANDIDATE_KEYS = ["delivery_mode", "deliveryMode", "mode", "data_mode", "dataMode"] as const;

/** 从事件 payload / 投影行读取三态（显式声明优先，其次 archive.dataMode）。 */
export function deliveryModeOf(input: unknown): DeliveryMode | null {
  if (!input || typeof input !== "object") return null;
  const row = input as Record<string, unknown>;
  for (const key of CANDIDATE_KEYS) {
    const value = row[key];
    if (typeof value === "string" && (DELIVERY_MODES as readonly string[]).includes(value)) return value as DeliveryMode;
  }
  const archive = row.archive;
  if (archive && typeof archive === "object") {
    const mode = (archive as Record<string, unknown>).dataMode ?? (archive as Record<string, unknown>).data_mode;
    if (typeof mode === "string" && (DELIVERY_MODES as readonly string[]).includes(mode)) return mode as DeliveryMode;
  }
  return null;
}

/** 校验三态在场：缺失/非法 → 抛错（调用方必须补标，不得默认 mock）。 */
export function assertDeliveryMode(input: unknown, context = "产出"): DeliveryMode {
  const mode = deliveryModeOf(input);
  if (!mode) throw new Error(`${context}缺少三态标识（mock|live|simulated）`);
  return mode;
}

/** UI/战报统一角标文案与色调（同一 mode 全端一致）。 */
export function modeBadge(mode: DeliveryMode): { label: string; tone: "info" | "go" | "warn" } {
  if (mode === "live") return { label: MODE_LABEL.live, tone: "go" };
  if (mode === "simulated") return { label: MODE_LABEL.simulated, tone: "info" };
  return { label: MODE_LABEL.mock, tone: "warn" };
}
