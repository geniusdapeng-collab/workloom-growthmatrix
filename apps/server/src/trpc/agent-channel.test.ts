/**
 * B-38 agent 通道 · 头解析与密钥校验（纯函数，无 DB）：
 * 未配置密钥 fail-closed、缺头拒绝、密钥常量时间比对、agent/system 身份互斥。
 */
import { describe, expect, it } from "vitest";
import {
  AGENT_HEADER_ID, AGENT_HEADER_KEY, AGENT_HEADER_SYSTEM, AGENT_HEADER_WORKSPACE, AGENT_KEY_ENV,
  constantTimeEqual, parseAgentChannel, toAgentActor,
} from "./agent-channel.js";

const KEY = "unit-test-agent-key-0123456789";
const headersOf = (values: Record<string, string>): Headers => {
  const h = new Headers();
  for (const [k, v] of Object.entries(values)) h.set(k, v);
  return h;
};
const env = { [AGENT_KEY_ENV]: KEY };

describe("B-38 agent 通道头解析", () => {
  it("未配置密钥（或短于 16 字符）→ 通道整体关闭，不降级", () => {
    const missing = parseAgentChannel(headersOf({ [AGENT_HEADER_ID]: "growth-lead", [AGENT_HEADER_KEY]: KEY, [AGENT_HEADER_WORKSPACE]: "ws-geo" }), {});
    expect(missing).toMatchObject({ ok: false, status: "unconfigured" });
    const tooShort = parseAgentChannel(headersOf({}), { [AGENT_KEY_ENV]: "short-key" });
    expect(tooShort).toMatchObject({ ok: false, status: "unconfigured" });
  });

  it("缺头 → missing；密钥不匹配 → mismatch（不泄露期望值）", () => {
    expect(parseAgentChannel(headersOf({ [AGENT_HEADER_ID]: "growth-lead" }), env))
      .toMatchObject({ ok: false, status: "missing" });
    const mismatch = parseAgentChannel(headersOf({
      [AGENT_HEADER_ID]: "growth-lead", [AGENT_HEADER_KEY]: `${KEY}x`, [AGENT_HEADER_WORKSPACE]: "ws-geo",
    }), env);
    expect(mismatch).toMatchObject({ ok: false, status: "mismatch" });
    expect(mismatch.ok === false && mismatch.reason.includes(KEY)).toBe(false);
  });

  it("agent 与 system 头同时出现 → 拒绝（归因唯一）", () => {
    expect(parseAgentChannel(headersOf({
      [AGENT_HEADER_ID]: "growth-lead", [AGENT_HEADER_SYSTEM]: "captain",
      [AGENT_HEADER_KEY]: KEY, [AGENT_HEADER_WORKSPACE]: "ws-geo",
    }), env)).toMatchObject({ ok: false, status: "mismatch" });
  });

  it("合法 agent 头 → principal=agent；合法 system 头 → principal=system", () => {
    const agent = parseAgentChannel(headersOf({
      [AGENT_HEADER_ID]: "growth-lead", [AGENT_HEADER_KEY]: KEY, [AGENT_HEADER_WORKSPACE]: "ws-geo",
    }), env);
    expect(agent).toEqual({ ok: true, principal: { kind: "agent", presetKey: "growth-lead" }, workspaceId: "ws-geo" });
    const system = parseAgentChannel(headersOf({
      [AGENT_HEADER_SYSTEM]: "captain", [AGENT_HEADER_KEY]: KEY, [AGENT_HEADER_WORKSPACE]: "ws-geo",
    }), env);
    expect(system).toEqual({ ok: true, principal: { kind: "system", systemId: "captain" }, workspaceId: "ws-geo" });
  });

  it("常量时间比较：长度不同直接 false，内容一致才 true", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });

  it("名册事实 → 网关 actor：围栏绑定/只读/高危原样带下去", () => {
    const actor = toAgentActor({
      presetKey: "growth-lead", version: "v3", status: "ready",
      readonly: false, fenceBindings: ["G-GROW1", "G12"], highRisk: true,
    });
    expect(actor).toMatchObject({ id: "growth-lead", type: "agent", readonly: false, highRisk: true, version: "v3" });
    expect(actor.fenceBindings).toEqual(["G-GROW1", "G12"]);
  });
});
