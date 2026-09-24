/**
 * B-71 协作纪律围栏（G-CON1 契约强制 / G-BB1 黑板单主写者）· 真实围栏包判定用例。
 *
 * 口径：用 `bundles/geo-growth/fences/geo-growth-collaboration.yml` 实物装载，
 * 正反例都断言（无契约排产被拒 + 带契约正常走默认级；非主写者写黑板被拒 + 主写者放行）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadFencePack } from "./dsl.js";
import { judge } from "./judge.js";

const PACK = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../bundles/geo-growth/fences/geo-growth-collaboration.yml",
);
const pack = loadFencePack(readFileSync(PACK, "utf-8"));

describe("B-71 协作纪律围栏包", () => {
  it("包本身是基线包（只可加严）：G-CON1/G-BB1 阻断 + G-CON2 域内放行", () => {
    expect(pack.version).toBe("geo-growth-collaboration/v1");
    expect(pack.defaultLevel).toBe("review");
    expect(pack.rules.map((r) => r.rule_id)).toEqual(["G-CON1", "G-BB1", "G-CON2"]);
    const blocks = pack.rules.filter((r) => r.level === "block").map((r) => r.rule_id);
    expect(blocks).toEqual(["G-CON1", "G-BB1"]);
    expect(pack.rules.every((r) => r.is_baseline)).toBe(true);
  });

  it("G-CON2：GEO 域内部产出走 auto（工具前缀视图命中），对外/花钱动作不在清单内", () => {
    // 工具前缀视图（safeObjectType('geo_queue.emit') = geo_queue）：内部队列推送 → auto
    const internal = judge({
      object: { type: "geo_queue" }, action: "geo_queue.emit", effect: "write", context: {},
    }, pack.rules, pack.defaultLevel);
    expect(internal.level).toBe("auto");
    expect(internal.impacts.some((i) => i.rule_id === "G-CON2" && i.result === "pass")).toBe(true);
    // 语义动作视图（geo.rewrite）同样命中
    const rewrite = judge({ object: { type: "geo" }, action: "geo.rewrite", effect: "write", context: {} }, pack.rules, pack.defaultLevel);
    expect(rewrite.level).toBe("auto");
    // 对外发布与花钱动作不在清单内 → 落包默认级（review），交由 G9/G-GEO1/G12/G-C02 把关
    const publish = judge({ object: { type: "geo" }, action: "rpa.publish", effect: "write", context: {} }, pack.rules, pack.defaultLevel);
    expect(publish.level).toBe("review");
    expect(publish.impacts).toEqual([]);
    const budget = judge({ object: { type: "budget" }, action: "budget.allocate.write", effect: "write", context: {} }, pack.rules, pack.defaultLevel);
    expect(budget.level).toBe("review");
  });

  it("G-CON1：无契约排产（task.dispatch / calendar.schedule / publish.dispatch）一律熔断", () => {
    for (const [type, action] of [
      ["task", "task.dispatch"],
      ["content_calendar", "calendar.schedule"],
      ["publish_task", "publish.dispatch"],
    ] as const) {
      const verdict = judge({ object: { type }, action, context: {} }, pack.rules, pack.defaultLevel);
      expect(verdict.level).toBe("block");
      expect(verdict.impacts.some((i) => i.rule_id === "G-CON1" && i.result === "blocked")).toBe(true);
    }
    // 只声明 has_contract=false 同样熔断（不得用"声明了字段"绕过）
    const explicitFalse = judge(
      { object: { type: "task" }, action: "task.dispatch", context: { has_contract: false } },
      pack.rules, pack.defaultLevel,
    );
    expect(explicitFalse.level).toBe("block");
  });

  it("G-CON1：带契约排产不再熔断，回到包默认级 review（对外动作仍需人审）", () => {
    const verdict = judge(
      { object: { type: "task" }, action: "task.dispatch", context: { has_contract: true } },
      pack.rules, pack.defaultLevel,
    );
    expect(verdict.level).toBe("review");
    expect(verdict.impacts).toEqual([]); // 本包两条规则都不命中；默认级 review 来自包声明
    expect(verdict.triggeredBy.join("；")).toContain("default_level");
  });

  it("G-BB1：非主写者写黑板熔断；主写者本人写入放行到默认级", () => {
    const intruder = judge({
      object: { type: "blackboard_entry" }, action: "blackboard.write",
      context: { blackboard_writer_declared: true, blackboard_writer: "review-analyst", actor_id: "data-board-officer" },
    }, pack.rules, pack.defaultLevel);
    expect(intruder.level).toBe("block");
    expect(intruder.impacts.some((i) => i.rule_id === "G-BB1" && i.result === "blocked")).toBe(true);

    const writer = judge({
      object: { type: "blackboard_entry" }, action: "blackboard.write",
      context: { blackboard_writer_declared: true, blackboard_writer: "review-analyst", actor_id: "review-analyst" },
    }, pack.rules, pack.defaultLevel);
    expect(writer.level).toBe("review");
    expect(writer.impacts).toEqual([]);
  });

  it("规则只吃不相关动作不误伤：其他对象/动作不受本包影响", () => {
    const verdict = judge(
      { object: { type: "content" }, action: "content.draft", context: {} },
      pack.rules, pack.defaultLevel,
    );
    expect(verdict.impacts).toEqual([]);
    expect(verdict.level).toBe("review");
  });
});
