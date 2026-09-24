/**
 * 业务关卡卡可见性判定（P2 任务详情内联卡）
 *
 * 背景（2026-09-24 真机复核，从 P2.tsx 内联表达式抽出并修复）：
 *  - 内联过滤原先**只按 LLM 规划出的动作名**猜"这是不是人审关卡"；
 *  - 规划器给出的自造动作名（实测 `publish_article`）既不以 `.publish`/`.submit` 等词根结尾，
 *    也不以白名单前缀开头 → 真实待放行的关卡被过滤掉：线程停在 pending_review，
 *    而页面上看不到任何可放行的卡（人无法放行 = 卡死，真机实测 T-126）。
 *  - 运行时已在 `approvals.snapshot` 落**关卡事实位**（`gate: true` + `tool`/`rule_ids`/`step_id`），
 *    因此判定改为「事实优先，命名白名单只兜历史遗留行」。
 */
export interface GateApprovalSnapshot {
  /** 运行时写入的关卡事实位；历史行可能缺失 */
  gate?: unknown;
  /** 计划动作名（历史行用它做兜底判定） */
  action?: unknown;
}

/** 历史遗留行的命名兜底（新行一律走 gate 事实位，不再依赖动作名） */
const LEGACY_ACTION_SUFFIX = /\.(confirm|execute|submit|publish|boost|approve|adjust|commit|finalize|topup)$/;
const LEGACY_ACTION_PREFIX = /^(gate|publish|ads|price|deal|budget|credit|spend|purchase|order|invoice)\./;

export function isVisibleGateCard(snapshot: GateApprovalSnapshot | null | undefined): boolean {
  const s = snapshot ?? {};
  if (s.gate === true) return true;
  if (s.gate === false) return false; // 显式否定（非人审关卡）优先于命名兜底
  const action = typeof s.action === "string" ? s.action : "";
  return LEGACY_ACTION_SUFFIX.test(action) || LEGACY_ACTION_PREFIX.test(action);
}
