/**
 * agent 通道（B-38）：内部数字员工写路径的鉴权解析。
 *
 * 背景：协作底座的契约/回执写路径此前只认「成员 JWT → human actor」，agent 只能从
 * 进程内（Runtime loop）直接调服务层写事件——跨进程的 agent（工位桥、夜班执行器、
 * 外部守护进程）没有合法的 tRPC 写入口，只能冒充人类成员，归因失真。
 *
 * 纪律（fail-closed）：
 *  - 共享密钥 `WORKLOOM_AGENT_KEY` 必须显式配置且 ≥16 字符；未配置时通道整体关闭，
 *    任何携带 agent 头的请求都不被承认（不降级成 human，也不放行）；
 *  - 密钥比较走常量时间（不因比较位置不同泄露前缀）；密钥只在内存中比对，不落盘、不落日志；
 *  - 本模块只做「头解析 + 密钥校验」纯逻辑；身份事实（status/readonly/fence_bindings/high_risk）
 *    一律回库刷新（见 service/agent-actor.ts），绝不采信客户端声明。
 */
import type { ActorInfo } from "@workloom/base/workdata";

export const AGENT_KEY_ENV = "WORKLOOM_AGENT_KEY";
export const AGENT_KEY_MIN_LENGTH = 16;
export const AGENT_HEADER_ID = "x-workloom-agent";
export const AGENT_HEADER_KEY = "x-workloom-agent-key";
export const AGENT_HEADER_WORKSPACE = "x-workloom-workspace";
export const AGENT_HEADER_SYSTEM = "x-workloom-system";

/**
 * 通道主体：`agent` 为数字员工（preset_key，回库刷新名册事实）；
 * `system` 为白名单系统组件（who.type=system，网关段①按系统通道处理）。
 */
export type AgentChannelPrincipal =
  | { kind: "agent"; presetKey: string }
  | { kind: "system"; systemId: string };

export type AgentChannelParse =
  | { ok: true; principal: AgentChannelPrincipal; workspaceId: string }
  | { ok: false; status: "unconfigured" | "missing" | "mismatch"; reason: string };

/** agent 通道关闭的规范值（未配置密钥时的上下文默认；测试与 createContext 共用同一常量） */
export const AGENT_CHANNEL_OFF: AgentChannelParse = {
  ok: false, status: "unconfigured", reason: "agent 通道未开启（WORKLOOM_AGENT_KEY 未配置）",
};

/** 常量时间字符串比较（长度不等直接 false；长度本身不是秘密）。 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 解析 agent 通道头并校验共享密钥。
 * 未配置密钥 / 缺头 / 密钥不匹配 → ok:false（调用方按 401 处理，不泄露密钥细节）。
 */
export function parseAgentChannel(headers: Headers, env: Record<string, string | undefined> = process.env): AgentChannelParse {
  const expected = (env[AGENT_KEY_ENV] ?? "").trim();
  if (expected.length < AGENT_KEY_MIN_LENGTH) {
    return {
      ok: false,
      status: "unconfigured",
      reason: `${AGENT_KEY_ENV} 未配置或短于 ${AGENT_KEY_MIN_LENGTH} 字符，agent 通道关闭（fail-closed）`,
    };
  }
  const presetKey = (headers.get(AGENT_HEADER_ID) ?? "").trim();
  const systemId = (headers.get(AGENT_HEADER_SYSTEM) ?? "").trim();
  const workspaceId = (headers.get(AGENT_HEADER_WORKSPACE) ?? "").trim();
  const key = headers.get(AGENT_HEADER_KEY) ?? "";
  if ((!presetKey && !systemId) || !workspaceId || !key) {
    return {
      ok: false,
      status: "missing",
      reason: `agent 通道缺少请求头（需 ${AGENT_HEADER_ID} 或 ${AGENT_HEADER_SYSTEM}、${AGENT_HEADER_KEY}、${AGENT_HEADER_WORKSPACE}）`,
    };
  }
  if (presetKey && systemId) {
    return { ok: false, status: "mismatch", reason: `agent 通道不允许同时声明 ${AGENT_HEADER_ID} 与 ${AGENT_HEADER_SYSTEM}（归因唯一）` };
  }
  if (!constantTimeEqual(key, expected)) {
    return { ok: false, status: "mismatch", reason: "agent 通道密钥不匹配" };
  }
  return {
    ok: true,
    principal: presetKey ? { kind: "agent", presetKey } : { kind: "system", systemId },
    workspaceId,
  };
}

/** 名册事实（回库刷新后的权威字段）；由 service/agent-actor.ts 提供。 */
export interface AgentRosterFacts {
  presetKey: string;
  version: string;
  status: string;
  readonly: boolean;
  fenceBindings: string[];
  highRisk: boolean;
}

/**
 * 名册事实 → 网关 actor。fence_bindings/readonly/high_risk 原样带下去：
 * 网关三段瀑布（F2.10/L9.1/L3.5）据此判定，未声明围栏的 agent 写动作会被拒。
 */
export function toAgentActor(facts: AgentRosterFacts): ActorInfo & { version: string } {
  return {
    id: facts.presetKey,
    type: "agent",
    fenceBindings: [...facts.fenceBindings],
    readonly: facts.readonly,
    highRisk: facts.highRisk,
    version: facts.version,
  };
}
