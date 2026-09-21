/**
 * model-router/ledger —— 模型配置版本台账纯函数（B-30）
 *
 * 目标：谁在何时把哪个场景换成了哪档/哪个模型、影响哪些场景、怎么回滚，全部可复算。
 * 本模块只做纯函数（diff / 回滚命令 / 台账摘要），落库与事件由服务层调用方完成。
 */
import type { Tier3 } from "./policy.js";

export interface ModelConfigSnapshot {
  /** 场景键（如 deep-analysis / content-generate / intent-route） */
  scene: string;
  tier: Tier3;
  /** 模型 ID（MODEL_CATALOG 中的 id） */
  model: string;
  /** noDowngrade 场景不允许跨档降级 */
  noDowngrade?: boolean;
}

export interface ModelConfigChange {
  scene: string;
  from: string;
  to: string;
  fromTier: Tier3 | null;
  toTier: Tier3;
  noDowngrade: boolean;
  /** 变更原因（人可读） */
  reason?: string;
}

const keyOf = (scene: string): string => scene.trim().toLowerCase();

/** 对比前后快照：只输出真实变化的场景（新增/切换/档位变化）。 */
export function diffModelConfig(prev: ModelConfigSnapshot[], next: ModelConfigSnapshot[]): ModelConfigChange[] {
  const before = new Map(prev.map((row) => [keyOf(row.scene), row]));
  const changes: ModelConfigChange[] = [];
  for (const row of next) {
    const old = before.get(keyOf(row.scene));
    if (old && old.model === row.model && old.tier === row.tier && Boolean(old.noDowngrade) === Boolean(row.noDowngrade)) {
      continue;
    }
    changes.push({
      scene: row.scene,
      from: old?.model ?? "(unset)",
      to: row.model,
      fromTier: old?.tier ?? null,
      toTier: row.tier,
      noDowngrade: row.noDowngrade === true,
      ...(old ? {} : { reason: "新增场景配置" }),
    });
  }
  // 移除的场景也要留痕（回滚时知道曾经存在）
  const nextScenes = new Set(next.map((row) => keyOf(row.scene)));
  for (const row of prev) {
    if (!nextScenes.has(keyOf(row.scene))) {
      changes.push({
        scene: row.scene, from: row.model, to: "(removed)", fromTier: row.tier, toTier: row.tier,
        noDowngrade: row.noDowngrade === true, reason: "场景配置移除",
      });
    }
  }
  return changes.sort((a, b) => a.scene.localeCompare(b.scene));
}

/** 回滚命令：由台账脚本原子重放（`--set scene=model`；不直接改 .env）。 */
export function buildRollbackCommand(change: ModelConfigChange): string {
  return `tsx scripts/model-ledger.mts --set ${change.scene}=${change.from}`;
}

export interface ModelLedgerEntry {
  at: string;
  by: string;
  reason?: string;
  changes: ModelConfigChange[];
}

/** 台账摘要（人可读；供战报/审计引用，回滚命令一并附上）。 */
export function summarizeModelLedger(entries: ModelLedgerEntry[]): string {
  if (entries.length === 0) return "模型配置台账：无变更记录";
  const lines = entries.map((entry) => {
    const detail = entry.changes
      .map((c) => `${c.scene}: ${c.from} → ${c.to}${c.noDowngrade ? "（noDowngrade）" : ""}`)
      .join("；");
    const rollback = entry.changes.map((c) => buildRollbackCommand(c)).join(" && ");
    return `${entry.at} · ${entry.by}${entry.reason ? ` · ${entry.reason}` : ""}：${detail}；回滚：${rollback}`;
  });
  return `模型配置台账（${entries.length} 次变更）：\n${lines.join("\n")}`;
}
