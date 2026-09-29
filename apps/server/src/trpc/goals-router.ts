/**
 * 目标与指标路由（GOAL-KPI-01 的对外入口）。
 *
 * 闭环第一环（目标注入，人的主权）与第五环（反馈对账）此前没有 API：
 * 目标只以文案存在，指标没有摄入通道，于是偏差节拍、KPI 熔断、命中率回测在真实数据下全部空转。
 * 这里补上三个动作（写路径与事件同一事务，D16）：
 *   goals.set      写入/更新目标（广播 goal.tracking）
 *   goals.refresh  用最新指标算出偏差并广播 goal.tracking（偏差节拍据此立项）
 *   metrics.ingest 写入指标（广播 metric.daily + store.daily.summary，供熔断与回测取数）
 *
 * 权限口径与线程派发（quest）一致：`capabilityWriteProcedure("quest")`——目标与指标都属于经营写动作。
 */
import { z } from "zod";
import { getAppPool, getGatewayPool } from "@workloom/db";
import { ingestMetric, latestGoal, refreshGoalTracking, setGoal } from "@workloom/base/captain";
import { capabilityWriteProcedure, router, scopeOf } from "./context.js";

const periodSchema = z.string().min(4).max(40);

export const goalsRouter = router({
  /** 读取当前目标（只读，便于前端展示与验收留痕） */
  current: capabilityWriteProcedure("quest").query(async ({ ctx }) => {
    const scope = scopeOf(ctx.identity);
    const goal = await latestGoal(getAppPool(), scope);
    return { goal: goal ?? null };
  }),

  /** 写入/更新目标 */
  set: capabilityWriteProcedure("quest")
    .input(z.object({
      metric: z.string().min(1).max(80),
      target: z.number().finite(),
      unit: z.string().max(20).optional(),
      periodStart: periodSchema,
      periodEnd: periodSchema,
      note: z.string().max(400).optional(),
      goalId: z.string().min(1).max(120).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const r = await setGoal(getAppPool(), getGatewayPool(), scope, ctx.identity.memberNo, input);
      return { eventId: r.eventId, goal: r.goal };
    }),

  /** 偏差对账：用最新指标刷新 goal.tracking（deviation_pt 供偏差节拍读取） */
  refresh: capabilityWriteProcedure("quest").mutation(async ({ ctx }) => {
    const scope = scopeOf(ctx.identity);
    return refreshGoalTracking(getAppPool(), getGatewayPool(), scope);
  }),
});

export const metricsRouter = router({
  /** 写入一条指标（行业无关：指标名与单位由调用方给定） */
  ingest: capabilityWriteProcedure("quest")
    .input(z.object({
      metric: z.string().min(1).max(80),
      value: z.number().finite(),
      unit: z.string().max(20).optional(),
      at: z.string().min(4).max(40).optional(),
      source: z.string().max(80).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const r = await ingestMetric(getAppPool(), getGatewayPool(), scope, ctx.identity.memberNo, input);
      return { eventId: r.eventId, summaryEventId: r.summaryEventId, summary: r.summary };
    }),
});
