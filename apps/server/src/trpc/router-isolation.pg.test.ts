/** Reproduce the original router's real mixed-artifact index and scoped mock outbox. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeAllPools, getAppPool, getOwnerPool, withWorkspace } from "@workloom/db";
import { gatewayAppendOnClient } from "@workloom/base/workdata";
import type { Identity } from "@workloom/base/tenancy";
import { insertQueuedThread } from "../runtime/thread-admission.js";
import { appRouter } from "./router.js";

const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL) && Boolean(process.env.DATABASE_APP_URL);
describe.runIf(RUN_DB)("真实路由：产物索引与 IM 模拟出站盒隔离", () => {
  const run = randomUUID();
  const makeIdentity = (index: number) => ({ kind: "member", memberId: `m-router-${index}-${run}`, memberNo: "MEM-001", name: "路由隔离夹具",
    role: "owner", tenantId: index === 2 ? `t-router-other-${run}` : `t-router-${run}`,
    workspaceId: `w-router-${index}-${run}`, plan: "pro" } satisfies Identity);
  const identities = [makeIdentity(0), makeIdentity(1), makeIdentity(2)] as const;
  const caller = (identity: Identity) => appRouter.createCaller({ session: identity, identity, partnerIdentity: null, headers: new Headers() });
  let root: string;
  const previousRoots = process.env.WORKLOOM_ARTIFACT_ROOTS;
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "matrix-router-contract-")));
    process.env.WORKLOOM_ARTIFACT_ROOTS = root;
    const owner = getOwnerPool();
    for (const tenantId of new Set(identities.map(item => item.tenantId))) {
      await owner.query("INSERT INTO tenants (id,name,plan) VALUES ($1,'路由隔离夹具','pro')", [tenantId]);
    }
    for (const own of identities) {
      await owner.query("INSERT INTO workspaces (id,tenant_id,name,slug,industry) VALUES ($1,$2,'路由隔离夹具',$1,'general')", [own.workspaceId, own.tenantId]);
      await owner.query("INSERT INTO members (id,workspace_id,member_no,name,role) VALUES ($1,$2,$3,'路由隔离夹具','owner')", [own.memberId, own.workspaceId, own.memberNo]);
    }
  });
  afterAll(async () => {
    if (previousRoots === undefined) delete process.env.WORKLOOM_ARTIFACT_ROOTS;
    else process.env.WORKLOOM_ARTIFACT_ROOTS = previousRoots;
    if (root) await rm(root, { recursive: true, force: true });
    await closeAllPools();
  });

  it("未知扩展名在前，清单返回的文档索引仍能取到同一文档", async () => {
    const own = identities[0];
    const path = join(root, "registered.md");
    const content = "# 实际登记的产物\n混合类型取件不换号。\n";
    await writeFile(path, content);
    const threadId = await withWorkspace(getAppPool(), own, async (_db, client) => {
      const id = await insertQueuedThread(client, { ...own, title: `混合产物 ${run}`, mode: "quest", createdBy: own.memberNo, agentId: null });
      await gatewayAppendOnClient(client, { ...own, actor: { type: "human", id: own.memberNo }, sessionId: id }, {
        who: { type: "human", id: own.memberNo },
        context: { tenant_id: own.tenantId, workspace_id: own.workspaceId, time: new Date().toISOString(), channel: "inapp" },
        object: { type: "thread", id }, decision: { action: "task.fixture", after: { outputs: [
          { path: join(root, "unsupported.data"), bytes: 1 }, { path, bytes: Buffer.byteLength(content) },
        ] } }, rule_impact: [],
      });
      return id;
    });
    const files = await caller(own).threads.artifacts({ threadId });
    expect(files).toHaveLength(1);
    const listed = files[0]!;
    const file = await caller(own).threads.artifactData({ threadId, index: listed.index });
    expect(Buffer.from(file.base64, "base64").toString()).toBe(content);
    expect(file.index).toBe(listed.index);
    expect(await caller(identities[1]).threads.artifacts({ threadId })).toEqual([]);
  });

  it("同通道的两个工作区及另一个租户看不到彼此审批卡；自己的卡片仍可读", async () => {
    const approvals: string[] = [];
    for (const own of identities.slice(0, 2)) {
      const approvalId = `APR-router-${own.workspaceId}`;
      await withWorkspace(getAppPool(), own, async (_db, client) => {
        const event = await gatewayAppendOnClient(client, { ...own, actor: { type: "human", id: own.memberNo } }, {
          who: { type: "human", id: own.memberNo },
          context: { tenant_id: own.tenantId, workspace_id: own.workspaceId, time: new Date().toISOString(), channel: "inapp" },
          object: { type: "fixture", id: own.workspaceId, label: `自己的审批对象 ${own.workspaceId}` },
          decision: { action: "content.draft", before: { draft: "before" }, after: { draft: own.workspaceId } }, rule_impact: [],
        });
        await client.query("INSERT INTO approvals (approval_id,tenant_id,workspace_id,event_id,channel,status,snapshot) VALUES ($1,$2,$3,$4,'dingtalk','pending','{}'::jsonb)",
          [approvalId, own.tenantId, own.workspaceId, event.eventId]);
      });
      approvals.push(approvalId);
      await caller(own).im.sendApprovalCard({ approvalId, channel: "dingtalk", conversationId: `conversation-${run}` });
    }
    for (const [index, own] of identities.slice(0, 2).entries()) {
      const result = await caller(own).im.outbox({ channel: "dingtalk" });
      expect(result.driver).toBe("mock");
      expect(result.outbox.map(item => item.card?.approvalId)).toEqual([approvals[index]]);
    }
    expect((await caller(identities[2]).im.outbox({ channel: "dingtalk" })).outbox).toEqual([]);
    expect((await caller(identities[0]).im.outbox({ channel: "feishu" })).outbox).toEqual([]);
  });
});
