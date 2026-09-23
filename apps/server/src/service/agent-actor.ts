/**
 * agent actor 解析（B-38）：把 agent 通道请求换成一个可写事件的名册 actor。
 *
 * 纪律：
 *  - 身份事实只认数据库名册（agents 表：status / readonly / fence_bindings / meta.high_risk），
 *    每次调用回库刷新，客户端声明一律不采信；
 *  - 工作区必须真实存在（否则 serviceTx 抛错 → 统一按「工作区不可用」拒绝）；
 *  - status != ready → 禁用（不区分「不存在」与「已停产」的措辞，避免枚举）；readonly preset
 *    不允许走写路径（读者可读，写者不可写）。
 */
import { svcQuery } from "./events.js";
import {
  AGENT_HEADER_SYSTEM,
  toAgentActor,
  type AgentChannelPrincipal,
  type AgentRosterFacts,
} from "../trpc/agent-channel.js";
import type { ActorInfo } from "@workloom/base/workdata";
import { SYSTEM_ACTOR_WHITELIST } from "@workloom/base/workdata";

export class AgentActorError extends Error {
  constructor(public readonly code: "NOT_FOUND" | "DISABLED" | "READONLY" | "WORKSPACE", message: string) {
    super(message);
    this.name = "AgentActorError";
  }
}

interface RosterRow {
  [key: string]: unknown;
  preset_key: string;
  version: string;
  status: string;
  readonly: boolean;
  fence_bindings: unknown;
  meta: unknown;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  }
  return [];
}

export async function resolveAgentActor(
  request: { principal: AgentChannelPrincipal; workspaceId: string },
  opts: { write: boolean },
): Promise<{ actor: ActorInfo & { version: string }; tenantId: string; workspaceId: string }> {
  const tenantRows = await svcQuery<{ tenant_id: string }>(request.workspaceId,
    `SELECT tenant_id FROM workspaces WHERE id=$1`, [request.workspaceId]).catch(() => {
    throw new AgentActorError("WORKSPACE", `agent 通道工作区不可用：${request.workspaceId}`);
  });
  const tenantId = tenantRows[0]?.tenant_id;
  if (!tenantId) throw new AgentActorError("WORKSPACE", `agent 通道工作区不可用：${request.workspaceId}`);

  if (request.principal.kind === "system") {
    const systemId = request.principal.systemId;
    if (!(SYSTEM_ACTOR_WHITELIST as readonly string[]).includes(systemId)) {
      throw new AgentActorError("NOT_FOUND",
        `system 通道只接受白名单组件（${AGENT_HEADER_SYSTEM}：${systemId} 不在白名单）`);
    }
    return { actor: { id: systemId, type: "system", version: "system" }, tenantId, workspaceId: request.workspaceId };
  }

  const presetKey = request.principal.presetKey;
  let rows: RosterRow[];
  try {
    rows = await svcQuery<RosterRow>(request.workspaceId,
      `SELECT preset_key, version, status, readonly, fence_bindings, meta FROM agents
        WHERE workspace_id=$1 AND preset_key=$2
        ORDER BY (status='ready') DESC, created_at DESC LIMIT 1`,
      [request.workspaceId, presetKey]);
  } catch (error) {
    throw new AgentActorError("WORKSPACE", `agent 通道名册不可读：${error instanceof Error ? error.message : String(error)}`);
  }
  const row = rows[0];
  if (!row) throw new AgentActorError("NOT_FOUND", `名册中不存在 preset「${presetKey}」`);
  if (row.status !== "ready") throw new AgentActorError("DISABLED", `preset「${presetKey}」当前状态 ${row.status}，不接受写动作`);
  const facts: AgentRosterFacts = {
    presetKey: row.preset_key,
    version: row.version,
    status: row.status,
    readonly: row.readonly === true,
    fenceBindings: asStringArray(row.fence_bindings),
    highRisk: (row.meta as { high_risk?: unknown } | null)?.high_risk === true,
  };
  if (opts.write && facts.readonly) {
    throw new AgentActorError("READONLY", `preset「${facts.presetKey}」是只读岗位，不接受写动作（L9.1）`);
  }
  return { actor: toAgentActor(facts), tenantId, workspaceId: request.workspaceId };
}
