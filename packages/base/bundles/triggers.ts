/**
 * bundles/triggers —— 声明式自动化触发器（随包声明 → 组合合并 → 幂等装载）
 *
 * 背景：触发器此前硬编码在各仓 seed 脚本，三包节拍无法合并，主工作区只落单包触发器。
 * 本模块把声明变成受控数据：解析 → cron 语法与动作白名单校验 → 跨包合并（主包优先、
 * 同名遮蔽留痕）。DB 写入由装配器调用（见 assembly.provisionComposedWorkforce 的扩展），
 * 本模块保持纯函数，便于门禁与单测。
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import YAML from "yaml";

export const TRIGGER_DECLARATION_VERSION = "workloom.triggers/v1";

export const TriggerDeclarationSchema = z.object({
  id: z.string().regex(/^tg-[a-z0-9][a-z0-9-]{0,60}$/),
  name: z.string().min(1).max(80),
  kind: z.enum(["cron", "event"]).default("cron"),
  schedule: z.string().min(1).max(120),
  action: z.object({
    /** 派遣岗位（preset_key）——与组合编制对账 */
    dispatch: z.string().regex(/^[a-z][a-z0-9-]{1,79}$/).optional(),
    /** 系统组件（night-shift / captain / trigger-engine 等）——与系统白名单对账 */
    system: z.string().regex(/^[a-z][a-z0-9-]{1,60}$/).optional(),
    /** 数字 CEO 节拍名（daily/queue/deviation/breaker/outcome/hr/board/org） */
    beat: z.string().min(1).max(40).optional(),
    /** 派遣模板标识（由运行时解释，如 intel.collect） */
    template: z.string().min(1).max(80).optional(),
  }).strict().refine(
    (action) => Boolean(action.dispatch || action.system || action.beat || action.template),
    { message: "action 至少声明 dispatch / system / beat / template 之一" },
  ),
  enabled: z.boolean().default(true),
  description: z.string().max(200).optional(),
}).strict();

export const TriggerDeclarationFileSchema = z.object({
  version: z.literal(TRIGGER_DECLARATION_VERSION),
  triggers: z.array(TriggerDeclarationSchema).min(1),
}).strict();

export type TriggerDeclaration = z.infer<typeof TriggerDeclarationSchema>;
export type TriggerDeclarationFile = z.infer<typeof TriggerDeclarationFileSchema>;

export class TriggerDeclarationError extends Error {
  constructor(public readonly source: string, message: string) {
    super(`触发器声明无效（${source}）：${message}`);
    this.name = "TriggerDeclarationError";
  }
}

/** cron 字段范围（分/时/日/月/周），与 night-shift 引擎的 5 字段语义一致 */
const CRON_RANGES: ReadonlyArray<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];

/** 校验单个 cron 字段（支持 *、逗号列表、range、步进、单值） */
function fieldValid(field: string, [min, max]: [number, number]): boolean {
  return field.split(",").every((part) => {
    const step = /^\*\/(\d+)$/.exec(part);
    if (step) return Number(step[1]) > 0;
    if (part === "*") return true;
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      return start >= min && end <= max && start <= end;
    }
    const single = Number(part);
    return Number.isInteger(single) && single >= min && single <= max;
  });
}

export function isValidCronExpression(expression: string): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((field, index) => fieldValid(field, CRON_RANGES[index]!));
}

export function parseTriggerDeclarations(text: string, source = "<inline>"): TriggerDeclarationFile {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (error) {
    throw new TriggerDeclarationError(source, `YAML 语法错误：${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = TriggerDeclarationFileSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new TriggerDeclarationError(source, `${first?.path.join(".") ?? ""} ${first?.message ?? "结构不合法"}`);
  }
  const ids = new Set<string>();
  for (const trigger of parsed.data.triggers) {
    if (ids.has(trigger.id)) throw new TriggerDeclarationError(source, `触发器 id 重复：${trigger.id}`);
    ids.add(trigger.id);
    if (trigger.kind === "cron" && !isValidCronExpression(trigger.schedule)) {
      throw new TriggerDeclarationError(source, `${trigger.id} 的 cron 表达式不合法：${trigger.schedule}`);
    }
  }
  return parsed.data;
}

export function loadTriggerDeclarations(path: string): TriggerDeclarationFile {
  if (!existsSync(path)) throw new TriggerDeclarationError(path, "文件不存在");
  return parseTriggerDeclarations(readFileSync(path, "utf-8"), path);
}

export interface TriggerDeclarationSource {
  bundleId: string;
  file: TriggerDeclarationFile;
}

export interface ComposedTrigger {
  declaration: TriggerDeclaration;
  /** 权威声明来自哪个行业包 */
  sourceBundleId: string;
  /** 被遮蔽的同名声明（仅留痕，不装载） */
  shadowedBundleIds: string[];
}

/**
 * 任务键（语义去重口径）：同一件"活儿"只能有一份权威声明，避免三包节拍合并后
 * 同一件事被重复执行（例如两个包各自声明 metrics 采集、四个 CEO 节拍各来一份）。
 *  - beat：数字 CEO 节拍按节拍名去重；
 *  - 其余：按执行主体（dispatch/system）+ 模板去重；
 *  - 无主体无模板的声明退化为按 id（解析阶段已保证 action 非空）。
 */
export function triggerJobKey(declaration: TriggerDeclaration): string {
  if (declaration.action.beat) return `beat:${declaration.action.beat}`;
  // 模板优先：同一模板（如 metrics.collect / comments.ingest）在组合日历里只保留一份权威声明，
  // 避免两个包各自派出不同岗位重复执行同一件事。
  if (declaration.action.template) return `tpl:${declaration.action.template}`;
  const actor = declaration.action.dispatch ?? declaration.action.system;
  if (actor) return `actor:${actor}`;
  return `id:${declaration.id}`;
}

export interface TriggerGap {
  triggerId: string;
  sourceBundleId: string;
  detail: string;
}

/**
 * 跨包合并：依赖包在前、主包在后；同名 id 主包优先，其余留痕。
 * 单包内重复在解析阶段已拒绝。
 */
export function mergeTriggerDeclarations(sources: readonly TriggerDeclarationSource[]): ComposedTrigger[] {
  const merged = new Map<string, ComposedTrigger>();
  for (const source of sources) {
    for (const declaration of source.file.triggers) {
      const jobKey = triggerJobKey(declaration);
      const current = merged.get(jobKey);
      if (!current) {
        merged.set(jobKey, { declaration, sourceBundleId: source.bundleId, shadowedBundleIds: [] });
        continue;
      }
      current.shadowedBundleIds.push(current.sourceBundleId);
      merged.set(jobKey, { declaration, sourceBundleId: source.bundleId, shadowedBundleIds: current.shadowedBundleIds });
    }
  }
  return [...merged.values()].sort((a, b) => a.declaration.id.localeCompare(b.declaration.id));
}

/**
 * 声明与编制对账：dispatch 岗位必须在组合编制内；beat 必须是已知 CEO 节拍名。
 * 未命中项如实报告（供装配前门禁使用，不自动修复）。
 */
export function triggerGapReport(
  composed: readonly ComposedTrigger[],
  refs: { presetKeys: readonly string[]; beats: readonly string[]; systems?: readonly string[] },
): TriggerGap[] {
  const presetKeys = new Set(refs.presetKeys);
  const beats = new Set(refs.beats);
  const systems = refs.systems ? new Set(refs.systems) : null;
  const gaps: TriggerGap[] = [];
  for (const item of composed) {
    const action = item.declaration.action;
    if (action.dispatch && !presetKeys.has(action.dispatch)) {
      gaps.push({ triggerId: item.declaration.id, sourceBundleId: item.sourceBundleId, detail: `派遣岗位未在编：${action.dispatch}` });
    }
    if (systems && action.system && !systems.has(action.system)) {
      gaps.push({ triggerId: item.declaration.id, sourceBundleId: item.sourceBundleId, detail: `系统组件不在白名单：${action.system}` });
    }
    if (action.beat && !beats.has(action.beat)) {
      gaps.push({ triggerId: item.declaration.id, sourceBundleId: item.sourceBundleId, detail: `未知 CEO 节拍：${action.beat}` });
    }
  }
  return gaps;
}
