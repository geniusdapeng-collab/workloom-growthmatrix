/**
 * 线程准入（U-03 闭环）：号源取号 + queued 建档 + PG 并发错误映射。
 *
 * 背景（排雷台账 U-03 / 独立验收实测）：
 *  - 12 路并发派遣时，号源撞号（23505）后的重试发生在**已中止的事务**里：
 *    取下一条号源的 SELECT 直接抛 25P02「current transaction is aborted」，
 *    tRPC 以 500 把 PG 原文透给客户端；
 *  - 并发上限判定与建档不在同一串行点：多路同时读到 count<上限时各自放行，
 *    实测占用可冲到 13/10（上限形同虚设）。
 *
 * 本模块只做两件事（判定口径仍在调用方/Router）：
 *  1. `insertQueuedThread`：在**已开启的事务**内取号并插入；撞号回滚到 SAVEPOINT 后重试，
 *     重试耗尽抛 `ThreadNumberConflictError`（业务语义，不带 PG 原文）；
 *  2. `mapDispatchDbError`：把并发/唯一冲突类 PG 错误码统一映射为 tRPC 409，
 *     PG 原文只进服务端日志，绝不进客户端响应。
 *
 * 使用前提：调用方已 BEGIN 且已设置 `app.workspace_id` / `app.tenant_id`（RLS 事务上下文）。
 */
import { TRPCError } from "@trpc/server";
import {
  insertWithReadableId, READABLE_ID_MAX_ATTEMPTS, THREAD_ID_SOURCE,
  type ReadableIdQueryable,
} from "@workloom/base/workdata";

/** 与唯一可读编号入口保持同一有界重试预算。 */
export const THREAD_INSERT_ATTEMPTS = READABLE_ID_MAX_ATTEMPTS;

/** 业务语义：取号重试后仍撞号（不是 PG 原文，客户端可安全展示） */
export class ThreadNumberConflictError extends Error {
  readonly code = "thread_number_conflict" as const;
  constructor(readonly attempts: number) {
    super(`任务号源并发冲突（取号重试 ${attempts} 次仍被占用），请重试`);
    this.name = "ThreadNumberConflictError";
  }
}

/** PG 并发/唯一冲突类错误码：23505 唯一键、25P02 事务已中止、40001 序列化失败、40P01 死锁 */
export const PG_CONFLICT_CODES: readonly string[] = Object.freeze(["23505", "25P02", "40001", "40P01"]);

export function isPgConflictCode(code: unknown): boolean {
  return typeof code === "string" && PG_CONFLICT_CODES.includes(code);
}

export const DISPATCH_CONFLICT_MESSAGE = "任务派遣并发冲突（号源或事务竞争），请重试";

/**
 * 冲突类 PG 错误 → tRPC 409（业务文案）；其它错误原样返回由上层处理。
 * PG 原文只写服务端日志（截断 200 字，避免日志淹没问题现场）。
 */
export function mapDispatchDbError(err: unknown): unknown {
  if (err instanceof TRPCError) return err;
  if (err instanceof AggregateError) {
    console.error("[dispatch] 保存点回退失败，已停止事务重试");
    return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "任务建档事务回退失败，请重试", cause: err });
  }
  // 号源重试耗尽：本身就是业务语义错误（文案不含 PG 原文），直接映射 409
  if (err instanceof ThreadNumberConflictError) {
    console.warn(`[dispatch] ${err.message}（已重试 ${err.attempts} 次）`);
    return new TRPCError({ code: "CONFLICT", message: err.message });
  }
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (!isPgConflictCode(code)) return err;
  const detail = err instanceof Error ? err.message : String(err);
  console.warn(`[dispatch] 并发冲突（pg:${String(code)}）→ 409：${detail.slice(0, 200)}`);
  return new TRPCError({ code: "CONFLICT", message: DISPATCH_CONFLICT_MESSAGE });
}

export interface QueuedThreadDraft {
  tenantId: string;
  workspaceId: string;
  title: string;
  mode: string;
  createdBy: string;
  agentId: string | null;
}

/**
 * 事务内取号并插入 queued 线程（返回可读线程号）。
 * 撞号重试包在 SAVEPOINT 里——这是 U-03 的关键：23505 之后事务已中止，
 * 必须 `ROLLBACK TO SAVEPOINT` 才能继续在同事务内取号/插入。
 */
export async function insertQueuedThread(client: ReadableIdQueryable, draft: QueuedThreadDraft): Promise<string> {
  try {
    const allocated = await insertWithReadableId(client, THREAD_ID_SOURCE, async (threadId) => {
      await client.query(
        `INSERT INTO threads (id, tenant_id, workspace_id, title, mode, status, created_by, agent_id)
         VALUES ($1,$2,$3,$4,$5,'queued',$6,$7)`,
        [threadId, draft.tenantId, draft.workspaceId, draft.title, draft.mode, draft.createdBy, draft.agentId],
      );
      return threadId;
    });
    return allocated.id;
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new ThreadNumberConflictError(THREAD_INSERT_ATTEMPTS);
    throw err;
  }
}
