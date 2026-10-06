import { afterEach, describe, expect, it, vi } from "vitest";
import { signDemoToken, type Identity } from "@workloom/base/tenancy";
const authority = vi.hoisted(() => vi.fn());
vi.mock("../service/access-authority.js", async (original) => ({
  ...await original<typeof import("../service/access-authority.js")>(), currentMemberAuthority: authority,
}));
import { agentDataMode, buildAgentRouter, filmStartInput, taskDispatchInput } from "./agent-router.js";
import { createContext, type TrpcContext } from "./context.js";

const identity: Identity = { kind: "member", memberId: "member-own", memberNo: "MEM-001", name: "测试成员",
  role: "owner", tenantId: "tenant-own", workspaceId: "workspace-own", plan: "pro" };
const input = { title: "整理沙箱交付说明", idempotencyKey: "own-key-0001" };
afterEach(() => { authority.mockReset(); });
describe("CLI/MCP 服务调用的输入与认证边界", () => {
  it("空白、超长、控制字符与未知身份/路径/计划字段拒绝", () => {
    for (const bad of [
      { ...input, title: " " }, { ...input, title: "x".repeat(121) }, { ...input, presetKey: "../worker" },
      { ...input, idempotencyKey: "1234567" }, { ...input, idempotencyKey: "00000000\n" },
      { ...input, memberNo: "MEM-999" }, { ...input, agentInvocation: {} }, { ...input, plan: [] }, { ...input, path: "/tmp/secret" },
    ]) expect(taskDispatchInput.safeParse(bad).success).toBe(false);
    expect(taskDispatchInput.parse({ ...input, title: "  实际目标  " })).toMatchObject({ title: "实际目标", runImmediately: false });
  });
  it("影片只接受登记阶段、JSON 原稿上限及受限选项数量", () => {
    const film = { projectId: "P-沙箱", document: {}, stages: ["spec"], idempotencyKey: "film-key-001" };
    expect(filmStartInput.safeParse(film).success).toBe(false);
    const good = { ...film, projectId: "P-sandbox" };
    expect(filmStartInput.parse(good)).toMatchObject({ stages: ["spec"], options: {} });
    for (const bad of [
      { ...good, stages: [] }, { ...good, stages: ["shell"] }, { ...good, projectId: "P/escape" },
      { ...good, projectId: "P..escape" }, { ...good, document: { text: "中".repeat(1_400_000) } },
      { ...good, options: Object.fromEntries(Array.from({ length: 41 }, (_, index) => [`key${index}`, true])) },
      { ...good, maxBudgetCny: 0 }, { ...good, maxBudgetCny: Number.POSITIVE_INFINITY }, { ...good, stages: ["spec"], forceApproval: true },
    ]) expect(filmStartInput.safeParse(bad).success).toBe(false);
  });
  it("未认证、只读以及 deny 任一必要写权限均在调用台账前拒绝", async () => {
    const dispatch = vi.fn();
    const router = buildAgentRouter({ dispatch });
    const context: TrpcContext = { identity: null, session: null, partnerIdentity: null, headers: new Headers() };
    await expect(router.createCaller(context).taskDispatch(input)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    for (const current of [
      { identity: { ...identity, role: "readonly" }, permissions: {} },
      { identity, permissions: { deny: ["task.dispatch"] } },
      { identity, permissions: { deny: ["workspace.write"] } },
    ]) {
      authority.mockResolvedValue(current);
      await expect(router.createCaller({ ...context, identity, session: identity }).taskDispatch(input))
        .rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("HTTP 头不能构造内部调用所有权，包括已验签成员请求", async () => {
    const token = await signDemoToken(identity);
    const context = await createContext(new Request("http://local.test", { headers: {
      authorization: `Bearer ${token}`, "x-agent-invocation": "spoofed", "x-agent-owner-token": "spoofed", "x-member-no": "MEM-999",
    } }));
    expect(context.identity?.memberNo).toBe("MEM-001");
    expect(context.agentInvocation).toBeUndefined();
  });
  it("模型或档案标注真实不晋升经营验证；任一模拟回执明确保持模拟", () => {
    expect(agentDataMode("real", [], {})).toBe("provided-unverified");
    expect(agentDataMode("simulated", [], {})).toBe("simulated");
    expect(agentDataMode("real", [{ receipt: { mode: "simulated" } }], {})).toBe("simulated");
    expect(agentDataMode("real", [], { LLM_PROVIDER: "mock" })).toBe("simulated");
    expect(agentDataMode(undefined, [], {})).toBe("unverified");
  });
});
