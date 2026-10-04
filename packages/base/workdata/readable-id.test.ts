import { describe, expect, it } from "vitest";
import {
  alignReadableIdSequences,
  insertWithReadableId,
  READABLE_ID_MAX_ATTEMPTS,
  THREAD_ID_SOURCE,
  VIDEO_PROJECT_ID_SOURCE,
  type ReadableIdQueryable,
} from "./readable-id.js";

function scriptedClient(numbers: unknown[], rollbackError?: Error) {
  const sql: string[] = [];
  let next = 0;
  const client = {
    async query(text: string) {
      sql.push(text);
      if (text.startsWith("ROLLBACK TO") && rollbackError) throw rollbackError;
      if (text.startsWith("SELECT public.")) return { rows: [{ n: numbers[next++] }] };
      return { rows: [] };
    },
  } as ReadableIdQueryable;
  return { client, sql };
}

describe("可读编号事务入口", () => {
  it("thread/video 的号源值直接落库，回传同一次写入的产物", async () => {
    for (const [source, expected] of [[THREAD_ID_SOURCE, "T-101"], [VIDEO_PROJECT_ID_SOURCE, "VID-101"]] as const) {
      const { client, sql } = scriptedClient([101]);
      const inserted: string[] = [];
      const outcome = await insertWithReadableId(client, source, async id => { inserted.push(id); return { artifact: id }; });
      expect(inserted).toEqual([expected]);
      expect(outcome).toEqual({ id: expected, value: { artifact: expected } });
      expect(sql.at(-1)).toBe("RELEASE SAVEPOINT readable_id_1");
    }
  });

  it("只重试唯一冲突，并且回退发生在下一次取号之前", async () => {
    const { client, sql } = scriptedClient([101, 102]);
    const inserted: string[] = [];
    const result = await insertWithReadableId(client, THREAD_ID_SOURCE, async id => {
      inserted.push(id);
      if (inserted.length === 1) throw Object.assign(new Error("collision"), { code: "23505" });
      return id;
    });
    expect(result.id).toBe("T-102");
    expect(inserted).toEqual(["T-101", "T-102"]);
    expect(sql).toEqual([
      "SAVEPOINT readable_id_1", "SELECT public.threads_max_t_no() AS n", "ROLLBACK TO SAVEPOINT readable_id_1",
      "SAVEPOINT readable_id_2", "SELECT public.threads_max_t_no() AS n", "RELEASE SAVEPOINT readable_id_2",
    ]);
  });

  it("重试耗尽抛出最后一次真实冲突，写入次数有界", async () => {
    const { client, sql } = scriptedClient(Array.from({ length: READABLE_ID_MAX_ATTEMPTS }, (_, i) => 101 + i));
    const failures: Error[] = [];
    const result = await insertWithReadableId(client, THREAD_ID_SOURCE, async () => {
      const error = Object.assign(new Error(`collision-${failures.length}`), { code: "23505" });
      failures.push(error);
      throw error;
    }).catch(error => error);
    expect(failures).toHaveLength(READABLE_ID_MAX_ATTEMPTS);
    expect(result).toBe(failures.at(-1));
    expect(sql.filter(text => text.startsWith("ROLLBACK TO"))).toHaveLength(READABLE_ID_MAX_ATTEMPTS);
  });

  it("外键错误只回退一次，保持原始错误并停止重试", async () => {
    const { client, sql } = scriptedClient([101, 102]);
    const error = Object.assign(new Error("foreign key"), { code: "23503" });
    await expect(insertWithReadableId(client, THREAD_ID_SOURCE, async () => { throw error; })).rejects.toBe(error);
    expect(sql.filter(text => text.startsWith("SELECT"))).toHaveLength(1);
  });

  it("回退失败保留原始写错与回退错误，禁止后续取号", async () => {
    const rollback = new Error("rollback lost connection");
    const collision = Object.assign(new Error("collision"), { code: "23505" });
    const { client, sql } = scriptedClient([101, 102], rollback);
    const result = await insertWithReadableId(client, THREAD_ID_SOURCE, async () => { throw collision; }).catch(error => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect(result.errors).toEqual([collision, rollback]);
    expect(result.cause).toBe(collision);
    expect(sql.filter(text => text.startsWith("SELECT"))).toHaveLength(1);
  });

  it.each([0, -1, NaN, Infinity, undefined, "invalid"])("不可用号源 %s 不调用写入方", async number => {
    const { client } = scriptedClient([number]);
    let writes = 0;
    await expect(insertWithReadableId(client, THREAD_ID_SOURCE, async () => { writes += 1; })).rejects.toThrow("取号失败");
    expect(writes).toBe(0);
  });

  it("手写号段对齐明确选择两种序列，使用 GREATEST 防止回拨", async () => {
    const sql: string[] = [];
    const client = { async query(text: string) { sql.push(text); return { rows: [{ v: "1042" }] }; } } as ReadableIdQueryable;
    expect(await alignReadableIdSequences(client)).toEqual({ threads: 1042, videoProjects: 1042 });
    expect(sql).toHaveLength(2);
    expect(sql.every(text => text.includes("GREATEST") && text.includes("last_value"))).toBe(true);
    sql.length = 0;
    expect(await alignReadableIdSequences(client, { threads: true, videoProjects: false })).toEqual({ threads: 1042, videoProjects: null });
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain("thread_no_seq");
    sql.length = 0;
    expect(await alignReadableIdSequences(client, { threads: false, videoProjects: false })).toEqual({ threads: null, videoProjects: null });
    expect(sql).toEqual([]);
  });
});
