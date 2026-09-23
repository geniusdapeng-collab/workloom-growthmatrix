/**
 * service · 协作底座（事件溯源）：对象读模型 / 任务契约 / 交接回执 / 决策配额 / 组合看板 / 数字人叙事。
 *
 * 纪律：
 *  - 全部读写在 RLS 上下文事务内（svcQuery / serviceTx）；
 *  - 契约与回执以五元事件落账（contract.* / receipt.record），不新增表，读模型由事件归约；
 *  - 对象读模型 = 每个业务对象的最新一条事件（谁在何时把什么改成了什么），天然可追溯；
 *  - 决策包超出配额不丢弃，进 overflow 并由上级分层处理（合并/延后/带内决掉再报备）。
 */
import {
  advanceContractStatus, buildDecisionPacket, buildPortfolio, composeNarrative, reduceContractStatus,
  HandoffReceiptSchema, TaskContractSchema,
  type ContractAction, type DecisionItem, type DecisionPacket, type DecisionTier, type HandoffReceipt,
  type ObjectState, type PortfolioDomain, type PortfolioSummary, type TaskContract,
} from "@workloom/base/collaboration";
import { appendEventOn, serviceTx, svcQuery } from "./events.js";
import {
  contractBudgetBand, ensureSettleGateOnClient, requireSettleGateOnClient, settleToLedgerOnClient,
} from "@workloom/base/collaboration";

type Actor = { id: string; type: "human" | "agent" | "system" };
type EventRow = Record<string, unknown> & {
  event_id: string;
  created_at: unknown;
  payload: {
    decision?: { action?: string; after?: unknown };
    object?: { type?: string; id?: string };
    who?: { id?: string };
    rule_impact?: Array<{ result?: string }>;
  } | null;
};

const str = (value: unknown): string => (value == null ? "" : String(value));
const iso = (value: unknown): string => {
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
};
const newId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** 事务内由事件归约契约当前状态（并发乐观锁：调用方比对期望状态） */
async function contractStatusOnClient(
  client: import("pg").PoolClient, workspaceId: string, contractId: string,
): Promise<{ status: string; threadId: string | null }> {
  const rows = await client.query<{ action: string; after: Record<string, unknown> | null; thread_id: string | null }>(
    `SELECT payload->'decision'->>'action' AS action,
            payload->'decision'->'after' AS after,
            payload->'decision'->'after'->>'threadId' AS thread_id
       FROM biz_events
      WHERE workspace_id=$1 AND payload->'object'->>'type'='task_contract' AND payload->'object'->>'id'=$2
      ORDER BY seq ASC LIMIT 5000`,
    [workspaceId, contractId],
  );
  const status = reduceContractStatus(rows.rows.map((r) => ({
    action: str(r.action),
    after: (r.after ?? null) as { status?: string } | null,
  }))) ?? null;
  const threadId = [...rows.rows].reverse().find((r) => r.thread_id)?.thread_id ?? null;
  return { status: status ?? "draft", threadId };
}

/** 获客用增班组 preset_key（组合看板域归属） */
const GROWTH_PRESETS = new Set([
  "growth-lead", "growth-strategist", "growth-experimenter", "lead-conversion-officer",
  "media-portfolio-manager", "cro-designer", "live-producer",
  "lifecycle-growth-officer", "growth-partnership-officer",
]);

const DOMAIN_LABELS: Record<string, string> = {
  growth: "获客增长", content: "内容与视频", hotel: "酒店运营", geo: "GEO 与数据", other: "系统与人工",
};

function domainOf(presetKey: string | null | undefined, bundle: string | null | undefined): string {
  if (presetKey && GROWTH_PRESETS.has(presetKey)) return "growth";
  if (bundle === "hotel") return "hotel";
  if (bundle === "ai-video") return "content";
  if (bundle === "geo-growth") return "geo";
  return "other";
}

/** 对象读模型：某对象最新一条事件（当前状态 + 版本号 + 最后修改人） */
export async function objectState(workspaceId: string, objectType: string, objectId: string): Promise<ObjectState | null> {
  const rows = await svcQuery<EventRow & { version?: unknown }>(workspaceId,
    `SELECT event_id, created_at, payload,
            count(*) OVER (PARTITION BY payload->'object'->>'type', payload->'object'->>'id') AS version
       FROM biz_events
      WHERE workspace_id=$1 AND payload->'object'->>'type'=$2 AND payload->'object'->>'id'=$3
      ORDER BY seq DESC LIMIT 1`,
    [workspaceId, objectType, objectId]);
  const row = rows[0];
  if (!row) return null;
  return {
    objectType,
    objectId,
    version: Number(row.version ?? 1),
    state: (row.payload?.decision?.after ?? {}) as Record<string, unknown>,
    owner: row.payload?.who?.id ?? null,
    updatedAt: iso(row.created_at),
    lastEventId: row.event_id,
  };
}

/** 最近变更流：每个对象最新一条事件，按时间倒序（近 30 天窗口，防全表扫描） */
export async function objectChanges(workspaceId: string, limit = 20): Promise<ObjectState[]> {
  const rows = await svcQuery<EventRow & { version?: unknown }>(workspaceId,
    `SELECT event_id, created_at, payload, version FROM (
       SELECT DISTINCT ON (payload->'object'->>'type', payload->'object'->>'id')
         event_id, created_at, payload, seq
         , count(*) OVER (PARTITION BY payload->'object'->>'type', payload->'object'->>'id') AS version
       FROM biz_events
       WHERE workspace_id=$1 AND payload->'object'->>'id' IS NOT NULL
         AND created_at > now() - interval '30 days'
       ORDER BY payload->'object'->>'type', payload->'object'->>'id', seq DESC
     ) latest ORDER BY created_at DESC LIMIT $2`,
    [workspaceId, limit]);
  return rows.map((row) => ({
    objectType: str(row.payload?.object?.type),
    objectId: str(row.payload?.object?.id),
    version: Number(row.version ?? 1),
    state: (row.payload?.decision?.after ?? {}) as Record<string, unknown>,
    owner: row.payload?.who?.id ?? null,
    updatedAt: iso(row.created_at),
    lastEventId: row.event_id,
  }));
}

async function contractEvents(workspaceId: string, contractId?: string): Promise<EventRow[]> {
  const params: unknown[] = [workspaceId];
  let where = `workspace_id=$1 AND payload->'object'->>'type'='task_contract'
    AND payload->'decision'->>'action' LIKE 'contract.%'`;
  if (contractId) {
    params.push(contractId);
    where += ` AND payload->'object'->>'id'=$2`;
  }
  return svcQuery<EventRow>(workspaceId,
    `SELECT event_id, created_at, payload FROM biz_events WHERE ${where} ORDER BY seq ASC LIMIT 5000`, params);
}

function toContract(events: EventRow[]): TaskContract | null {
  if (events.length === 0) return null;
  const first = events[0]!;
  const last = events[events.length - 1]!;
  const base = (first.payload?.decision?.after ?? {}) as Record<string, unknown>;
  const status = reduceContractStatus(events.map((e) => ({
    action: str(e.payload?.decision?.action),
    after: (e.payload?.decision?.after ?? null) as { status?: string } | null,
  }))) ?? "draft";
  return TaskContractSchema.parse({
    ...base,
    id: str(first.payload?.object?.id),
    status,
    updatedAt: iso(last.created_at),
  });
}

export async function listContracts(workspaceId: string): Promise<TaskContract[]> {
  const rows = await contractEvents(workspaceId);
  const byId = new Map<string, EventRow[]>();
  for (const row of rows) {
    const id = str(row.payload?.object?.id);
    if (!id) continue;
    const list = byId.get(id) ?? [];
    list.push(row);
    byId.set(id, list);
  }
  return [...byId.values()]
    .map((events) => toContract(events))
    .filter((c): c is TaskContract => c !== null)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export async function getContract(workspaceId: string, contractId: string): Promise<TaskContract | null> {
  return toContract(await contractEvents(workspaceId, contractId));
}

export interface CreateContractInput {
  title: string;
  goal: string;
  /** 兼容字段：契约发起人一律以 actor.id 落账，客户端传入值不采信（防冒名） */
  requester?: string;
  assigneePreset: string;
  verifierPreset: string;
  successCriteria: string[];
  budgetAmount?: number;
  currency?: string;
  deadline?: string | null;
  mode: TaskContract["mode"];
}

export async function createContract(workspaceId: string, actor: Actor, input: CreateContractInput): Promise<TaskContract> {
  const id = newId("CT");
  const at = new Date().toISOString();
  const contract = TaskContractSchema.parse({
    id, ...input, requester: actor.id, budgetAmount: input.budgetAmount ?? 0, currency: input.currency ?? "CNY",
    deadline: input.deadline ?? null, status: "draft", createdAt: at, updatedAt: at,
  });
  // B-40：创建即发出（draft→offer 一步完成，与表持久化路径同一语义）：
  // 两条事件同一 COMMIT（create + offer），读模型归约出 offered，不需要客户端再补一次 offer。
  const offered = advanceContractStatus("draft", "offer");
  if (!offered.ok) throw new Error(offered.reason);
  await serviceTx(workspaceId, async (client, scope) => {
    await appendEventOn(client, scope, actor, {
      objectType: "task_contract", objectId: id, action: "contract.create", after: contract,
    });
    await appendEventOn(client, scope, actor, {
      objectType: "task_contract", objectId: id, action: "contract.offer",
      after: {
        status: offered.status, assigneePreset: contract.assigneePreset, verifierPreset: contract.verifierPreset,
        budgetAmount: contract.budgetAmount, mode: contract.mode, updatedAt: at,
      },
    });
  });
  return { ...contract, status: offered.status, updatedAt: at };
}

export async function advanceContract(
  workspaceId: string, actor: Actor, contractId: string, action: string,
): Promise<TaskContract> {
  const current = await getContract(workspaceId, contractId);
  if (!current) throw new Error(`契约不存在：${contractId}`);
  const next = advanceContractStatus(current.status, action as ContractAction);
  if (!next.ok) throw new Error(next.reason);
  const at = new Date().toISOString();
  const band = contractBudgetBand();
  const overBand = Number(current.budgetAmount ?? 0) > band;
  const result = await serviceTx(workspaceId, async (client, scope) => {
    // 并发乐观锁：事务内重读读模型，状态被其他写入推进则拒绝本次迁移（不静默覆盖）
    const live = await contractStatusOnClient(client, workspaceId, contractId);
    if (live.status !== current.status) {
      throw new Error(`契约 ${contractId} 状态已变化（${current.status} → ${live.status}），本次 ${action} 拒绝，请重读后重试`);
    }

    // B-40 ①：accept 自动建线程（契约↔线程；同事务，无线程则不算开工）
    let threadId = live.threadId;
    if (action === "accept" && !threadId) {
      threadId = `T-${contractId.slice(-12)}`;
      await client.query(
        `INSERT INTO threads (id, tenant_id, workspace_id, title, mode, status, progress_done, progress_total, created_by, agent_id)
         VALUES ($1,$2,$3,$4,'quest','running',0,1,$5,$6) ON CONFLICT (id) DO NOTHING`,
        [threadId, scope.tenantId, scope.workspaceId, current.title, actor.id, current.assigneePreset],
      );
    }

    const after: Record<string, unknown> = { status: next.status, updatedAt: at };
    if (threadId) after.threadId = threadId;
    // B-40 ②：deliver 点名 verifier（契约↔验收岗位）
    if (action === "deliver") {
      after.verifierPreset = current.verifierPreset;
      after.verifyRequested = true;
    }

    // B-40 ③：verify 时若超自治带 → 同事务落一道业务关卡（等待放行；无回执不算完成）
    if (action === "verify" && overBand) {
      const ev = await appendEventOn(client, scope, actor, {
        objectType: "task_contract", objectId: contractId, action: `contract.${action}`,
        after: { ...after, budgetBand: band, settleGateRequired: true },
      });
      const gate = await ensureSettleGateOnClient(client, scope, {
        contractId, title: current.title, amount: Number(current.budgetAmount ?? 0),
        currency: current.currency, band, eventId: ev.eventId, threadId: threadId ?? null,
        verifierPreset: current.verifierPreset,
      });
      return { threadId: threadId ?? null, gate, settle: null };
    }

    // B-40 ④：settle 先校验关卡、落台账，再把结算事实写进同一条契约事件（append-only，不回写事件）
    if (action === "settle") {
      const gate = await requireSettleGateOnClient(client, scope, {
        contractId, amount: Number(current.budgetAmount ?? 0), band,
      });
      if (!gate.ok) {
        throw new Error(
          `契约 ${contractId} 预算 ${current.budgetAmount} ${current.currency} 超自治带 ${band}：结算需业务关卡 ${gate.gateId} 放行（当前 ${gate.status ?? "缺失"}）`,
        );
      }
      const ledger = await settleToLedgerOnClient(client, scope, {
        contractId, amount: Number(current.budgetAmount ?? 0), currency: current.currency,
        actor: { id: actor.id, type: actor.type }, threadId: threadId ?? null, approvalId: gate.gateId,
      });
      await appendEventOn(client, scope, actor, {
        objectType: "task_contract", objectId: contractId, action: `contract.${action}`,
        after: {
          ...after,
          settleAmount: Number(current.budgetAmount ?? 0), currency: current.currency,
          ledgerId: ledger.ledgerId, ledgerEventId: ledger.ledgerEventId,
          approvalId: gate.gateId, budgetBand: band, settleDeduped: ledger.deduped,
        },
      });
      return { threadId: threadId ?? null, gate: null, settle: { ...ledger, approvalId: gate.gateId } };
    }

    await appendEventOn(client, scope, actor, {
      objectType: "task_contract", objectId: contractId, action: `contract.${action}`,
      after,
    });
    return { threadId: threadId ?? null, gate: null, settle: null };
  });

  const updated: TaskContract = {
    ...current,
    status: next.status,
    updatedAt: at,
  };
  return Object.assign(updated, {
    threadId: result.threadId,
    ...(result.settle ? {
      settleAmount: Number(current.budgetAmount ?? 0), currency: current.currency,
      ledgerId: result.settle.ledgerId, ledgerEventId: result.settle.ledgerEventId, approvalId: result.settle.approvalId,
    } : {}),
    ...(result.gate ? { settleGateId: result.gate.gateId, settleGateTier: result.gate.tier, settleGateCreated: result.gate.created } : {}),
  });
}

export interface RecordReceiptInput {
  contractId: string;
  from: string;
  to: string;
  summary: string;
  evidence?: string[];
  qualityFlags?: string[];
}

export async function recordReceipt(workspaceId: string, actor: Actor, input: RecordReceiptInput): Promise<HandoffReceipt> {
  const id = newId("RC");
  const at = new Date().toISOString();
  const receipt = HandoffReceiptSchema.parse({
    id, ...input, evidence: input.evidence ?? [], qualityFlags: input.qualityFlags ?? [], createdAt: at,
  });
  await serviceTx(workspaceId, async (client, scope) => {
    await appendEventOn(client, scope, actor, {
      objectType: "handoff_receipt", objectId: id, action: "receipt.record", after: receipt,
    });
  });
  return receipt;
}

export async function listReceipts(workspaceId: string, contractId?: string): Promise<HandoffReceipt[]> {
  const params: unknown[] = [workspaceId];
  let where = `workspace_id=$1 AND payload->'decision'->>'action'='receipt.record'`;
  if (contractId) {
    params.push(contractId);
    where += ` AND payload->'decision'->'after'->>'contractId'=$2`;
  }
  const rows = await svcQuery<EventRow>(workspaceId,
    `SELECT event_id, created_at, payload FROM biz_events
      WHERE ${where}
      ORDER BY seq DESC LIMIT 200`,
    params);
  return rows
    .map((row) => HandoffReceiptSchema.parse({ ...(row.payload?.decision?.after ?? {}), createdAt: iso(row.created_at) }));
}

/** 决策信箱批次化：待批审批按 tier/截止/风险排序，默认 ≤7 件，超出进 overflow */
export async function decisionPacket(workspaceId: string, quota = 7): Promise<DecisionPacket> {
  const rows = await svcQuery<Record<string, unknown>>(workspaceId,
    `SELECT a.approval_id, a.tier, a.snapshot, a.created_at,
            e.payload->'decision'->>'action' AS action,
            e.payload->'object'->>'type' AS object_type,
            e.payload->'object'->>'id' AS object_id
      FROM approvals a LEFT JOIN biz_events e ON e.event_id=a.event_id
      WHERE a.workspace_id=$1 AND a.status='pending'
        AND a.approval_id NOT LIKE 'apr-suite-%'
        AND COALESCE(e.payload->'decision'->>'action','') NOT LIKE 'suite.%'
        AND COALESCE(e.payload->'decision'->>'action','') NOT LIKE 'test.%'
      ORDER BY a.created_at ASC`,
    [workspaceId]);
  const rank: Record<DecisionTier, number> = { l4_chairman: 3, l3_fleet: 2, l2_captain: 1 };
  const items: DecisionItem[] = rows.map((row) => {
    const rawTier = str(row.tier);
    const tier: DecisionTier = rawTier === "l4_chairman" || rawTier === "l3_fleet" ? rawTier : "l2_captain";
    const snapshot = (row.snapshot ?? {}) as Record<string, unknown>;
    const after = (snapshot.after ?? {}) as Record<string, unknown>;
    const highRisk = snapshot.high_risk === true || after.high_risk === true ? 2 : 0;
    return {
      id: str(row.approval_id),
      title: str(snapshot.title ?? after.title ?? row.action ?? row.approval_id),
      tier,
      risk: rank[tier] + highRisk,
      deadline: str(snapshot.expires_at) || null,
      createdAt: iso(row.created_at),
      action: str(row.action) || undefined,
      objectType: str(row.object_type) || undefined,
      objectId: str(row.object_id) || undefined,
    };
  });
  return buildDecisionPacket(items, quota);
}

/** 组合看板：按域聚合在编人数、待批、近 7 天动作与红线 */
export async function portfolioSummary(workspaceId: string): Promise<PortfolioSummary> {
  const agents = await svcQuery<Record<string, unknown>>(workspaceId,
    `SELECT preset_key, meta->>'sourceBundleId' AS bundle FROM agents WHERE workspace_id=$1`,
    [workspaceId]);
  const domainByPreset = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const row of agents) {
    const preset = str(row.preset_key);
    const domain = domainOf(preset, str(row.bundle) || null);
    domainByPreset.set(preset, domain);
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  const events = await svcQuery<Record<string, unknown>>(workspaceId,
    `SELECT payload->'who'->>'id' AS who,
            EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(payload->'rule_impact','[]'::jsonb)) r
                   WHERE r->>'result'='blocked') AS red
       FROM biz_events
      WHERE workspace_id=$1 AND created_at > now() - interval '7 days'
      ORDER BY seq DESC
      LIMIT 5000`,
    [workspaceId]);
  const actions = new Map<string, number>();
  const reds = new Map<string, number>();
  for (const row of events) {
    const domain = domainByPreset.get(str(row.who)) ?? "other";
    actions.set(domain, (actions.get(domain) ?? 0) + 1);
    if (row.red === true) reds.set(domain, (reds.get(domain) ?? 0) + 1);
  }
  const pendingRows = await svcQuery<Record<string, unknown>>(workspaceId,
    `SELECT e.payload->'who'->>'id' AS who FROM approvals a
      LEFT JOIN biz_events e ON e.event_id=a.event_id
      WHERE a.workspace_id=$1 AND a.status='pending'`,
    [workspaceId]);
  const pending = new Map<string, number>();
  for (const row of pendingRows) {
    const domain = domainByPreset.get(str(row.who)) ?? "other";
    pending.set(domain, (pending.get(domain) ?? 0) + 1);
  }
  const domains: PortfolioDomain[] = ["growth", "content", "hotel", "geo", "other"]
    .filter((domain) => (counts.get(domain) ?? 0) > 0 || (pending.get(domain) ?? 0) > 0)
    .map((domain) => ({
      domain,
      label: DOMAIN_LABELS[domain] ?? domain,
      agents: counts.get(domain) ?? 0,
      pending: pending.get(domain) ?? 0,
      actions7d: actions.get(domain) ?? 0,
      redLines7d: reds.get(domain) ?? 0,
    }));
  return buildPortfolio(domains);
}

/** 数字人单一叙事：组合看板 + 决策包 → 一段可播报叙述 */
export async function fleetNarrative(workspaceId: string, workspaceName?: string): Promise<{
  narrative: string; portfolio: PortfolioSummary; packet: DecisionPacket;
}> {
  const [portfolio, packet] = await Promise.all([
    portfolioSummary(workspaceId),
    decisionPacket(workspaceId, 7),
  ]);
  const wsRows = await svcQuery<Record<string, unknown>>(workspaceId,
    `SELECT name FROM workspaces WHERE id=$1`, [workspaceId]);
  const name = workspaceName ?? (str(wsRows[0]?.name) || "当前工作区");
  return { narrative: composeNarrative({ workspaceName: name, portfolio, packet, northStar: null }), portfolio, packet };
}
