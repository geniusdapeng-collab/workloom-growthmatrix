/**
 * collaboration/settlement —— 契约结算与业务关卡（B-40）的共享实现。
 *
 * 为什么单独一层：契约有两条推进路径——表持久化（`collaboration/store.ts`，供脚本/CLI）
 * 与事件溯源（`apps/server/src/service/collaboration.ts`，供 tRPC）。两条路径必须给出**同一套**
 * 结算纪律，否则"脚本里合规、界面上绕过"。本模块把三条纪律收敛为可复用的 DB 助手：
 *
 *  ① 自治预算带：结算金额 ≤ 带 → 内部协作自动结算；> 带 → 必须先有业务关卡放行（去审批化口径）；
 *  ② 关卡幂等：同一契约只有一道结算关卡（`apr-<契约>-settle`），重复 verify 不重复建行；
 *  ③ 结算同事务：台账行（budget_ledger）+ 计量事件 + 契约事件同一 COMMIT，幂等键 `contract:<id>`。
 */
import type pg from "pg";
import { recordCostInTx } from "../cost-ledger/index.js";

export interface SettleScope { tenantId: string; workspaceId: string }
export type SettlementTier = "l3_fleet" | "l4_chairman";

export const DEFAULT_CONTRACT_BUDGET_BAND = 500;
/** 超带 10 倍以上升 L4（董事长），其余走 L3（舰队）放行 */
export const CONTRACT_L4_MULTIPLIER = 10;

/** 自治预算带（环境可覆盖；非法值回落到默认带，不静默放开） */
export function contractBudgetBand(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.WORKLOOM_CONTRACT_BUDGET_BAND ?? DEFAULT_CONTRACT_BUDGET_BAND);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_CONTRACT_BUDGET_BAND;
}

/** 契约结算关卡的稳定 id（幂等锚点，同一契约不重复建关卡） */
export function contractGateId(contractId: string): string {
  return `apr-${contractId.toLowerCase()}-settle`;
}

export function contractGateTier(amount: number, band: number): SettlementTier {
  return amount > band * CONTRACT_L4_MULTIPLIER ? "l4_chairman" : "l3_fleet";
}

/**
 * 超带契约在 verify 时落一道待放行关卡（同事务；`ON CONFLICT` 保证幂等）。
 * 返回是否为本次新建（重复 verify 已存在 → created=false）。
 */
export async function ensureSettleGateOnClient(
  client: pg.PoolClient,
  scope: SettleScope,
  input: {
    contractId: string; title: string; amount: number; currency: string;
    band: number; eventId: string; threadId: string | null; verifierPreset?: string;
  },
): Promise<{ gateId: string; tier: SettlementTier; created: boolean }> {
  const gateId = contractGateId(input.contractId);
  const tier = contractGateTier(input.amount, input.band);
  const existing = await client.query<{ status: string }>(
    `SELECT status FROM approvals WHERE workspace_id=$1 AND approval_id=$2`,
    [scope.workspaceId, gateId],
  );
  if (existing.rows[0]) return { gateId, tier, created: false };
  await client.query(
    `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, tier, snapshot)
     VALUES ($1,$2,$3,$4,'inapp','pending',$5,$6)
     ON CONFLICT (event_id, channel) DO NOTHING`,
    [gateId, scope.tenantId, scope.workspaceId, input.eventId, tier, JSON.stringify({
      action: "contract.settle", title: `契约结算待放行：${input.title}`.slice(0, 200),
      high_risk: tier === "l4_chairman", contract_id: input.contractId,
      budget_amount: input.amount, currency: input.currency, band: input.band,
      verifier_preset: input.verifierPreset ?? null, thread_id: input.threadId,
    })],
  );
  return { gateId, tier, created: true };
}

/**
 * 结算前校验关卡：带内自动放行；超带必须有 `approved` 关卡。
 * 返回 `ok:false` 时调用方必须拒绝结算（fail-closed）。
 */
export async function requireSettleGateOnClient(
  client: pg.PoolClient,
  scope: SettleScope,
  input: { contractId: string; amount: number; band: number },
): Promise<{ ok: true; gateId: string | null } | { ok: false; gateId: string; status: string | null }> {
  if (!(input.amount > input.band)) return { ok: true, gateId: null };
  const gateId = contractGateId(input.contractId);
  const row = await client.query<{ status: string }>(
    `SELECT status FROM approvals WHERE workspace_id=$1 AND approval_id=$2`,
    [scope.workspaceId, gateId],
  );
  const status = row.rows[0]?.status ?? null;
  return status === "approved" ? { ok: true, gateId } : { ok: false, gateId, status };
}

/**
 * 结算落账（与契约状态迁移同一事务）：台账行 + `budget.cost_recorded` 事件，幂等键 `contract:<id>`。
 * 超带结算必须携带已放行关卡 id（调用方先跑 requireSettleGateOnClient）。
 */
export async function settleToLedgerOnClient(
  client: pg.PoolClient,
  scope: SettleScope,
  input: {
    contractId: string; amount: number; currency: string;
    actor: { id: string; type: "human" | "agent" | "system" };
    threadId: string | null; approvalId: string | null;
  },
): Promise<{ ledgerId: string; ledgerEventId: string | null; deduped: boolean }> {
  const ledger = await recordCostInTx(client, scope, {
    projectId: input.contractId, costKind: "labor", amount: input.amount,
    currency: input.currency, idempotencyKey: `contract:${input.contractId}`,
    by: input.actor.id,
    meta: {
      contractId: input.contractId, threadId: input.threadId, approvalId: input.approvalId,
      source: "contract.settle", actor: input.actor.id, actorType: input.actor.type,
    },
  });
  return { ledgerId: String(ledger.row.id), ledgerEventId: ledger.eventId, deduped: ledger.deduped };
}
