/**
 * 节拍调度器回归（BEATS-01）：
 *  - 内置节拍表必须自洽（id/beat 唯一、cron 合法、时点不打架）；
 *  - 到点判定必须与 cron 语义一致（08:30 晨报、周一 09:30 周会、每月 1 日 10:00 董事会包）；
 *  - 开关默认关闭（不写任何事件），显式开启才启动；
 *  - 未开启时 startBeatsScheduler 返回可调用的停止函数（幂等、不抛错）。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  BEAT_SCENES,
  DEFAULT_BEAT_TRIGGERS,
  beatsConfigFromEnv,
  beatsEnabled,
  dueBuiltinBeats,
  startBeatsScheduler,
} from "./beats-scheduler.js";

const ENV_KEYS = ["WORKLOOM_BEATS_ENABLED", "WORKLOOM_BEATS_MS", "WORKLOOM_BEATS_WORKSPACES"] as const;
const saved = new Map<string, string | undefined>();
for (const k of ENV_KEYS) saved.set(k, process.env[k]);

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("内置节拍表（BEATS-01）", () => {
  it("12 个节拍：id 唯一、beat 唯一、cron 合法", () => {
    expect(DEFAULT_BEAT_TRIGGERS).toHaveLength(12);
    const ids = DEFAULT_BEAT_TRIGGERS.map((d) => d.id);
    const beats = DEFAULT_BEAT_TRIGGERS.map((d) => d.beat);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(beats).size).toBe(beats.length);
    for (const def of DEFAULT_BEAT_TRIGGERS) {
      expect(def.schedule.trim().split(/\s+/)).toHaveLength(5);
      // 每个节拍都要有场景映射（值可为 undefined，但键必须存在）
      expect(Object.prototype.hasOwnProperty.call(BEAT_SCENES, def.beat)).toBe(true);
    }
  });

  it("同一分钟不会命中两个节拍（时点不打架；扫描 8 天覆盖跨月 1 日）", () => {
    // 采样等价性前提：所有节拍的分钟位都是 5 的倍数（下一条断言锁死），因此只需扫 5 分钟粒度。
    for (const def of DEFAULT_BEAT_TRIGGERS) {
      const minuteField = def.schedule.trim().split(/\s+/)[0]!;
      expect(minuteField.split(",").every((part) => {
        if (part === "*") return true;
        const step = /^\*\/(\d+)$/.exec(part);
        if (step) return Number(step[1]) % 5 === 0;
        const single = Number(part);
        return Number.isInteger(single) && single % 5 === 0;
      })).toBe(true);
    }
    // 扫 8 天（含 10 月 1 日的月度节拍）的每 5 分钟切面，每次命中数必须 ≤1
    const start = new Date("2026-09-28T00:00:00+08:00").getTime();
    for (let i = 0; i < 8 * 24 * 12; i += 1) {
      const hits = dueBuiltinBeats(new Date(start + i * 5 * 60_000));
      expect(hits.length).toBeLessThanOrEqual(1);
    }
  });

  it("08:30 命中每日晨报；09:30 与 11:00 在非周一不命中", () => {
    expect(dueBuiltinBeats(new Date("2026-09-29T08:30:00+08:00"))).toEqual(["beat-daily"]);
    expect(dueBuiltinBeats(new Date("2026-09-29T08:29:00+08:00"))).toEqual([]);
    expect(dueBuiltinBeats(new Date("2026-09-29T09:30:00+08:00"))).toEqual([]);
    expect(dueBuiltinBeats(new Date("2026-09-29T11:00:00+08:00"))).toEqual([]);
  });

  it("周一 09:30 命中周经营会全稿；每月 1 日 10:00 命中董事会包", () => {
    expect(dueBuiltinBeats(new Date("2026-09-28T09:30:00+08:00"))).toEqual(["beat-weekly"]);
    expect(dueBuiltinBeats(new Date("2026-10-01T10:00:00+08:00"))).toEqual(["beat-board"]);
    expect(dueBuiltinBeats(new Date("2026-10-01T10:20:00+08:00"))).toEqual(["beat-outcome"]);
    expect(dueBuiltinBeats(new Date("2026-10-01T10:30:00+08:00"))).toEqual(["beat-monthly"]);
  });

  it("每 2 小时的 :40 命中队列裁决；每 4 小时的 :15 命中偏差扫描", () => {
    expect(dueBuiltinBeats(new Date("2026-09-29T14:40:00+08:00"))).toEqual(["beat-queue"]);
    expect(dueBuiltinBeats(new Date("2026-09-29T12:15:00+08:00"))).toEqual(["beat-deviation"]);
  });
});

describe("开关与配置（默认关闭）", () => {
  it("未设置 WORKLOOM_BEATS_ENABLED 时默认关闭", () => {
    delete process.env.WORKLOOM_BEATS_ENABLED;
    expect(beatsEnabled()).toBe(false);
  });

  it("显式设置 1 才开启；其它值仍视为关闭", () => {
    process.env.WORKLOOM_BEATS_ENABLED = "1";
    expect(beatsEnabled()).toBe(true);
    process.env.WORKLOOM_BEATS_ENABLED = "true";
    expect(beatsEnabled()).toBe(false);
  });

  it("配置解析：默认 60s 全工作区；支持毫秒与白名单", () => {
    delete process.env.WORKLOOM_BEATS_MS;
    delete process.env.WORKLOOM_BEATS_WORKSPACES;
    expect(beatsConfigFromEnv()).toEqual({ intervalMs: 60_000, workspaces: [] });
    process.env.WORKLOOM_BEATS_MS = "5000";
    process.env.WORKLOOM_BEATS_WORKSPACES = " ws-geo , ws-yunqi ,, ";
    expect(beatsConfigFromEnv()).toEqual({ intervalMs: 5_000, workspaces: ["ws-geo", "ws-yunqi"] });
    process.env.WORKLOOM_BEATS_MS = "not-a-number";
    expect(beatsConfigFromEnv().intervalMs).toBe(60_000);
  });

  it("未开启时 startBeatsScheduler 不抛错且返回可调用的停止函数", () => {
    process.env.WORKLOOM_BEATS_ENABLED = "0";
    const stop = startBeatsScheduler({ intervalMs: 1 });
    expect(typeof stop).toBe("function");
    expect(() => stop()).not.toThrow();
  });

  it("开启但 intervalMs<=0 时返回空停止函数（不启动循环）", () => {
    process.env.WORKLOOM_BEATS_ENABLED = "1";
    const stop = startBeatsScheduler({ intervalMs: 0 });
    expect(typeof stop).toBe("function");
    stop();
  });
});
