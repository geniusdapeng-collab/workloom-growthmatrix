/**
 * collaboration/store —— 任务契约持久化（B-37/B-40 底座）
 *
 * 纪律：
 *  - 每次状态迁移先过 `advanceContractStatus` 纯函数，非法迁移拒绝（不跳步、不信任客户端状态）；
 *  - 契约行与 `contract.<action>` 五元事件同一 COMMIT（D16）；
 *  - 租户隔离走 RLS；DELETE 不授予 app 角色（只增不改）。
 */
import type pg from "pg";
import { gatewayAppendOnClient } from "../workdata/gateway.js";
import { advanceContractStatus, type ContractAction } from "./contract.js";
import {
  contractBudgetBand, ensureSettleGateOnClient, requireSettleGateOnClient, settleToLedgerOnClient,
} from "./settlement.js";
import {
  TaskContractSchema,
  type CollaborationMode, type ContractStatus, type TaskContract, type TaskContractLinks,
} from "./schema.js";

export type StoredTaskContract = TaskContract & TaskContractLinks;

interface Scope { tenantId: string; workspaceId: string }
export interface ContractActor { id: string; type: "human" | "agent" | "system" }

export class ContractStoreError extends Error {
  constructor(public readonly code: "NOT_FOUND" | "BAD_INPUT" | "BAD_STATE", message: string) {
    super(message);
    this.name = "ContractStoreError";
  }
}

export interface CreateContractInput {
  id: string;
  title: string;
  goal: string;
  requester: string;
  assigneePreset: string;
  verifierPreset: string;
  successCriteria: string[];
  budgetAmount?: number;
  currency?: string;
  deadline?: string | null;
  mode: CollaborationMode;
  threadId?: string | null;
  bundleScope?: string[];
  matrixRefs?: string[];
}

interface ContractRow {
  id: string; title: string; goal: string; requester: string;
  assignee_preset: string; verifier_preset: string; success_criteria: string[] | string;
  budget_amount: string | number; currency: string; deadline: string | null; mode: string;
  status: string; thread_id: string | null; bundle_scope: string[] | string; matrix_refs: string[] | string;
  created_at: string; updated_at: string;
}

const asArray = (value: string[] | string | null): string[] => {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try { return JSON.parse(value) as string[]; } catch { return []; }
  }
  return [];
};

function toContract(row: ContractRow): StoredTaskContract {
  return {
    id: row.id, title: row.title, goal: row.goal, requester: row.requester,
    assigneePreset: row.assignee_preset, verifierPreset: row.verifier_preset,
    successCriteria: asArray(row.success_criteria),
    budgetAmount: Number(row.budget_amount ?? 0), currency: row.currency,
    deadline: row.deadline, mode: row.mode as CollaborationMode, status: row.status as ContractStatus,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    threadId: row.thread_id ?? null, bundleScope: asArray(row.bundle_scope), matrixRefs: asArray(row.matrix_refs),
  };
}

async function withTx<T>(app: pg.Pool, scope: Scope, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function emitContractEvent(
  client: pg.PoolClient, scope: Scope, actor: ContractActor, contractId: string,
  /** `create` 是首条事件（读模型 reduceContractStatus 显式识别它 → draft），不属于状态机迁移动作 */
  action: ContractAction | "create", after: Record<string, unknown>,
): Promise<string> {
  const r = await gatewayAppendOnClient(client, { ...scope, actor: { id: actor.id, type: actor.type } }, {
    who: { type: actor.type, id: actor.id },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
    object: { type: "task_contract", id: contractId },
    decision: { action: `contract.${action}`, after },
    rule_impact: [],
  });
  return r.eventId;
}

/**
 * 创建契约：落到 **`draft`**，并写 `contract.create` 事件（全量快照）。
 *
 * 2026-09-24 修复（H-23）：本仓 B-40 曾把创建改成"draft→offer 一步完成"（落 offered、发 contract.offer），
 * 于是 `collaboration.contracts.create` 返回 offered，与状态机契约（draft→offered→accepted…）、
 * 客户端 schema 默认值、以及验收套件"初始为草稿"的口径相冲突；而基座仓的同名链路是**只发 create**。
 * 现在与基座同语义：创建=草稿；要推进请显式 `advance(id, "offer")`（状态机与事件读模型据此归约）。
 */
export async function createContract(
  app: pg.Pool, scope: Scope, input: CreateContractInput, actor: ContractActor,
): Promise<{ contract: StoredTaskContract; eventId: string }> {
  const parsed = TaskContractSchema.safeParse({
    id: input.id, title: input.title, goal: input.goal, requester: input.requester,
    assigneePreset: input.assigneePreset, verifierPreset: input.verifierPreset,
    successCriteria: input.successCriteria, budgetAmount: input.budgetAmount ?? 0,
    currency: input.currency ?? "CNY", deadline: input.deadline ?? null, mode: input.mode,
    status: "draft", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  if (!parsed.success) {
    throw new ContractStoreError("BAD_INPUT", parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}：${i.message}`).join("；"));
  }
  return withTx(app, scope, async (client) => {
    const inserted = await client.query<ContractRow>(
      `INSERT INTO task_contracts
         (id, tenant_id, workspace_id, title, goal, requester, assignee_preset, verifier_preset,
          success_criteria, budget_amount, currency, deadline, mode, status, thread_id, bundle_scope, matrix_refs, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [input.id, scope.tenantId, scope.workspaceId, input.title, input.goal, input.requester,
       input.assigneePreset, input.verifierPreset, JSON.stringify(input.successCriteria),
       input.budgetAmount ?? 0, input.currency ?? "CNY", input.deadline ?? null, input.mode, "draft",
       input.threadId ?? null, JSON.stringify(input.bundleScope ?? []), JSON.stringify(input.matrixRefs ?? []), actor.id],
    );
    const eventId = await emitContractEvent(client, scope, actor, input.id, "create", {
      /**
       * 全量快照（2026-09-24 修复）：create 是契约的**首条**事件，而事件溯源读模型
       * （apps/server/src/service/collaboration.ts）以首条事件的 after 还原契约。
       * 此前只写 5 个字段，导致 store 路径建出的契约在 tRPC 列表里 zod 校验失败
       * （/portfolio 页 500："title: expected string, received undefined"）。
       * 现在与事件溯源路径同口径：after = 行内全量契约快照。
       */
      ...toContract(inserted.rows[0]!),
    });
    return { contract: toContract(inserted.rows[0]!), eventId };
  });
}

/** 推进契约状态：非法迁移直接拒绝；状态与事件同一 COMMIT。 */
export async function advanceContract(
  app: pg.Pool, scope: Scope, input: { id: string; action: ContractAction; by: ContractActor; note?: string },
): Promise<{ contract: StoredTaskContract; eventId: string }> {
  return withTx(app, scope, async (client) => {
    const current = await client.query<ContractRow>(
      `SELECT * FROM task_contracts WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
      [scope.workspaceId, input.id],
    );
    const row = current.rows[0];
    if (!row) throw new ContractStoreError("NOT_FOUND", `契约 ${input.id} 不存在`);
    const advance = advanceContractStatus(row.status as ContractStatus, input.action);
    if (!advance.ok) throw new ContractStoreError("BAD_STATE", advance.reason);
    // B-40：accept 自动建线程（契约↔线程）；deliver 在事件里点名 verifier（契约↔验收岗位）
    let threadId = row.thread_id;
    if (input.action === "accept" && !threadId) {
      threadId = `T-${input.id.slice(-12)}`;
      await client.query(
        `INSERT INTO threads (id, tenant_id, workspace_id, title, mode, status, progress_done, progress_total, created_by, agent_id)
         VALUES ($1,$2,$3,$4,'quest','running',0,1,$5,$6) ON CONFLICT (id) DO NOTHING`,
        [threadId, scope.tenantId, scope.workspaceId, row.title, input.by.id, row.assignee_preset],
      );
    }
    const band = contractBudgetBand();
    const amount = Number(row.budget_amount ?? 0);
    const overBand = amount > band;
    // B-40：settle 前先校验业务关卡（超自治带必须有 approved 关卡），再与台账同一 COMMIT 落账
    let gateId: string | null = null;
    let settle: { ledgerId: string; ledgerEventId: string | null; deduped: boolean } | null = null;
    if (input.action === "settle") {
      const gate = await requireSettleGateOnClient(client, scope, { contractId: input.id, amount, band });
      if (!gate.ok) {
        throw new ContractStoreError("BAD_STATE",
          `预算 ${amount} ${row.currency} 超自治带 ${band}：结算需业务关卡 ${gate.gateId} 放行（当前 ${gate.status ?? "缺失"}）`);
      }
      gateId = gate.gateId;
      settle = await settleToLedgerOnClient(client, scope, {
        contractId: input.id, amount, currency: row.currency,
        actor: { id: input.by.id, type: input.by.type }, threadId, approvalId: gateId,
      });
    }
    const updated = await client.query<ContractRow>(
      `UPDATE task_contracts SET status=$3, thread_id=$4, updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING *`,
      [scope.workspaceId, input.id, advance.status, threadId],
    );
    const eventId = await emitContractEvent(client, scope, input.by, input.id, input.action, {
      status: advance.status, from: row.status,
      ...(threadId ? { threadId } : {}),
      ...(input.action === "deliver" ? { verifierPreset: row.verifier_preset, verifyRequested: true } : {}),
      ...(input.action === "settle" ? {
        settleAmount: amount, currency: row.currency, budgetBand: band, approvalId: gateId,
        ledgerId: settle?.ledgerId ?? null, ledgerEventId: settle?.ledgerEventId ?? null,
        settleDeduped: settle?.deduped ?? false,
      } : {}),
      ...(input.note ? { note: input.note } : {}),
    });
    // verify 且超带：落待放行关卡（与 verify 事件同一 COMMIT；幂等）
    if (input.action === "verify" && overBand) {
      await ensureSettleGateOnClient(client, scope, {
        contractId: input.id, title: row.title, amount, currency: row.currency,
        band, eventId, threadId, verifierPreset: row.verifier_preset,
      });
    }
    return { contract: toContract(updated.rows[0]!), eventId };
  });
}

export async function getContract(app: pg.Pool, scope: Scope, id: string): Promise<StoredTaskContract | null> {
  return withTx(app, scope, async (client) => {
    const r = await client.query<ContractRow>(
      `SELECT * FROM task_contracts WHERE workspace_id=$1 AND id=$2`, [scope.workspaceId, id],
    );
    return r.rows[0] ? toContract(r.rows[0]) : null;
  });
}

export async function listContracts(
  app: pg.Pool, scope: Scope, filter: { status?: ContractStatus; limit?: number } = {},
): Promise<StoredTaskContract[]> {
  return withTx(app, scope, async (client) => {
    const r = await client.query<ContractRow>(
      `SELECT * FROM task_contracts WHERE workspace_id=$1 AND ($2::text IS NULL OR status=$2::text)
        ORDER BY updated_at DESC LIMIT $3`,
      [scope.workspaceId, filter.status ?? null, filter.limit ?? 50],
    );
    return r.rows.map(toContract);
  });
}
