/**
 * U-03 回归（单元级）：号源撞号必须回滚到 SAVEPOINT 后重试，冲突类 PG 错误必须映射业务 409。
 *
 * 现场对照（独立验收实测）：12 路并发派遣 → 撞号 → 23505 之后事务已中止，
 * 重试的取号 SELECT 抛 25P02「current transaction is aborted」，tRPC 以 500 透出 PG 原文；
 * 另一面是并发上限判定与建档不同串行点，实测占用冲到 13/10。
 */
import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import {
  DISPATCH_CONFLICT_MESSAGE,
  PG_CONFLICT_CODES,
  ThreadNumberConflictError,
  THREAD_INSERT_ATTEMPTS,
  insertQueuedThread,
  isPgConflictCode,
  mapDispatchDbError,
} from "./thread-admission.js";

/** 极简假客户端：只记录语句并按脚本返回/抛错 */
function fakeClient(inserts: Array<"ok" | { code: string }>) {
  const statements: string[] = [];
  const insertedValues: unknown[][] = [];
  let insertCall = 0;
  const client = {
    async query(text: string, values?: unknown[]) {
      statements.push((text.trim().split("\n")[0] ?? "").trim());
      if (text.startsWith("SELECT public.threads_max_t_no")) {
        return { rows: [{ n: 101 + insertCall }] } as never;
      }
      if (text.startsWith("INSERT INTO threads")) {
        insertedValues.push(values ?? []);
        const scripted = inserts[insertCall] ?? "ok";
        insertCall += 1;
        if (scripted !== "ok") {
          const err = new Error("duplicate key value violates unique constraint \"threads_pkey\"");
          (err as { code?: string }).code = scripted.code;
          throw err;
        }
        return { rows: [] } as never;
      }
      return { rows: [] } as never;
    },
  };
  return { client, statements, insertedValues };
}

const DRAFT = {
  tenantId: "tenant-demo",
  workspaceId: "ws-yunqi",
  title: "U-03 单测",
  mode: "quest",
  createdBy: "MEM-001",
  agentId: null,
};

describe("insertQueuedThread（号源 SAVEPOINT 重试）", () => {
  it("首次撞号 23505 → 回滚保存点后重取号成功（不再毒化事务）", async () => {
    const { client, statements } = fakeClient([{ code: "23505" }, "ok"]);
    const id = await insertQueuedThread(client as never, DRAFT);
    expect(id).toBe("T-102"); // 首次 101 → T-101 撞号；重取 102 → T-102，不额外 +1
    expect(statements.filter((s) => s.startsWith("SAVEPOINT"))).toHaveLength(2);
    expect(statements.filter((s) => s.startsWith("ROLLBACK TO SAVEPOINT"))).toHaveLength(1);
    expect(statements.at(-1)).toMatch(/^RELEASE SAVEPOINT/);
  });

  it("有界重试都撞号 → 抛业务语义的 ThreadNumberConflictError（文案不含 PG 原文）", async () => {
    const exhausted = fakeClient(Array.from({ length: THREAD_INSERT_ATTEMPTS }, () => ({ code: "23505" })));
    const thrown = await insertQueuedThread(exhausted.client as never, DRAFT).catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(ThreadNumberConflictError);
    expect((thrown as Error).message).not.toMatch(/duplicate key|23505|pg/i);
  });

  it("非撞号错误原样抛出（不被吞、不被改写）", async () => {
    const { client } = fakeClient([{ code: "23503" }]);
    await expect(insertQueuedThread(client as never, DRAFT)).rejects.toMatchObject({ code: "23503" });
  });

  it("号源直接返回 101 时只落 T-101，保留调用方实际路由模式", async () => {
    const { client, insertedValues } = fakeClient(["ok"]);
    await expect(insertQueuedThread(client as never, { ...DRAFT, mode: "ask" })).resolves.toBe("T-101");
    expect(insertedValues).toEqual([["T-101", DRAFT.tenantId, DRAFT.workspaceId, DRAFT.title, "ask", DRAFT.createdBy, null]]);
  });

  it("保存点回退失败保留双错误并停止重试", async () => {
    const collision = Object.assign(new Error("synthetic collision"), { code: "23505" });
    const rollback = new Error("synthetic rollback failure");
    let inserts = 0;
    const client = {
      async query(sql: string) {
        if (sql.startsWith("SELECT public.threads_max_t_no")) return { rows: [{ n: 101 }] };
        if (sql.startsWith("INSERT INTO threads")) { inserts += 1; throw collision; }
        if (sql.startsWith("ROLLBACK TO SAVEPOINT")) throw rollback;
        return { rows: [] };
      },
    };
    const failure = await insertQueuedThread(client as never, DRAFT).catch(error => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toEqual([collision, rollback]);
    expect(inserts).toBe(1);
  });
});

describe("mapDispatchDbError（PG 并发错误 → 业务 409，不泄漏 PG 原文）", () => {
  it.each(PG_CONFLICT_CODES)("PG %s → CONFLICT 且使用业务文案", (code) => {
    const mapped = mapDispatchDbError(Object.assign(new Error("current transaction is aborted, commands ignored"), { code }));
    expect(mapped).toBeInstanceOf(TRPCError);
    expect((mapped as TRPCError).code).toBe("CONFLICT");
    expect((mapped as TRPCError).message).toBe(DISPATCH_CONFLICT_MESSAGE);
  });

  it("ThreadNumberConflictError → CONFLICT（保留业务文案）", () => {
    const mapped = mapDispatchDbError(new ThreadNumberConflictError(2));
    expect(mapped).toBeInstanceOf(TRPCError);
    expect((mapped as TRPCError).message).toMatch(/号源并发冲突/);
    expect((mapped as TRPCError).message).not.toMatch(/duplicate key|pg|23505/i);
  });

  it("回退失败以业务文案返回 500，不泄漏双错误中的 PG 原文", () => {
    const failure = new AggregateError([new Error("duplicate key value"), new Error("current transaction is aborted")], "取号事务回退失败，已停止重试");
    const mapped = mapDispatchDbError(failure) as TRPCError;
    expect(mapped.code).toBe("INTERNAL_SERVER_ERROR");
    expect(mapped.message).toBe("任务建档事务回退失败，请重试");
    expect(mapped.message).not.toMatch(/duplicate key|current transaction|23505/i);
  });

  it("已是 TRPCError 或非冲突错误 → 原样返回（不改变既有错误面）", () => {
    const trpc = new TRPCError({ code: "TOO_MANY_REQUESTS", message: "并发上限 10/工作区（L3.1/G11）" });
    expect(mapDispatchDbError(trpc)).toBe(trpc);
    const plain = Object.assign(new Error("connection terminated"), { code: "57P01" });
    expect(mapDispatchDbError(plain)).toBe(plain);
  });

  it("isPgConflictCode 只认冲突类码", () => {
    expect(isPgConflictCode("23505")).toBe(true);
    expect(isPgConflictCode("57P01")).toBe(false);
    expect(isPgConflictCode(undefined)).toBe(false);
  });
});
