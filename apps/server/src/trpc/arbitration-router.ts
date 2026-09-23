/**
 * arbitration router（B-39）：冲突仲裁对象的数据面。
 *  - 读：列表/单对象（RLS 上下文，越权查询返回空）；
 *  - 写：raise（登记）→ arbitrate（裁决；升级同事务落 L4 关卡）→ resolve（人审收口）；
 *  - agent 通道：数字员工可登记冲突与请求裁决（actor 落 agent，不冒充人类）。
 */
import { z } from "zod";
import { agentProcedure, protectedProcedure, router, scopeOf, writeProcedure } from "./context.js";
import {
  arbitrateConflict, ConflictRaiseSchema, getConflict, listConflicts, raiseConflict, resolveConflict,
} from "../service/arbitration.js";

const STATUSES = ["raised", "granted", "escalated", "resolved"] as const;
const actorOf = (ctx: { identity: { memberNo: string } }) => ({ id: ctx.identity.memberNo, type: "human" as const });

export const arbitrationRouter = router({
  conflicts: router({
    list: protectedProcedure
      .input(z.object({
        status: z.enum(STATUSES).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }).optional())
      .query(async ({ ctx, input }) => listConflicts(scopeOf(ctx.identity).workspaceId, input ?? {})),
    get: protectedProcedure
      .input(z.object({ id: z.string().trim().min(1).max(120) }))
      .query(async ({ ctx, input }) => getConflict(scopeOf(ctx.identity).workspaceId, input.id)),
    raise: writeProcedure
      .input(ConflictRaiseSchema)
      .mutation(async ({ ctx, input }) => raiseConflict(scopeOf(ctx.identity).workspaceId, actorOf(ctx), input)),
    arbitrate: writeProcedure
      .input(z.object({ id: z.string().trim().min(1).max(120) }))
      .mutation(async ({ ctx, input }) => arbitrateConflict(scopeOf(ctx.identity).workspaceId, actorOf(ctx), input.id)),
    resolve: writeProcedure
      .input(z.object({
        id: z.string().trim().min(1).max(120),
        resolution: z.string().trim().min(1).max(2000),
      }))
      .mutation(async ({ ctx, input }) => resolveConflict(scopeOf(ctx.identity).workspaceId, actorOf(ctx), input.id, { resolution: input.resolution })),
  }),
  /** B-38 × B-39：数字员工经 agent 通道登记冲突与请求裁决 */
  agent: router({
    conflicts: router({
      raise: agentProcedure
        .input(ConflictRaiseSchema)
        .mutation(async ({ ctx, input }) => raiseConflict(ctx.agentScope.workspaceId, ctx.agent, input)),
      arbitrate: agentProcedure
        .input(z.object({ id: z.string().trim().min(1).max(120) }))
        .mutation(async ({ ctx, input }) => arbitrateConflict(ctx.agentScope.workspaceId, ctx.agent, input.id)),
    }),
  }),
});
