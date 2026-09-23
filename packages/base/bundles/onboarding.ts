/**
 * 首日上岗内容包装载（B-63）：把「五关引导」的行业内容从 web 客户端搬到行业包。
 *
 * 背景：内容此前硬编码在 `apps/web/src/onboarding/questline.config.ts`（706 行 TS），
 * 于是① 内容随代码发布、不随 Bundle 版本治理；② 服务端无法据包下发（换 Bundle 必须发前端）；
 * ③ 进度只存 localStorage，换设备即丢（B-63 要「断点续播跨端」）。
 *
 * 现在：
 *   · 通用件（关卡文案/成就/价值口径/出口）在 `packages/base/bundles/templates/questline-base.yml`；
 *   · 行业内容（员工卡/目标卡/任务卡/驳回枚举）在 `bundles/<bundleId>/onboarding/questline.yml`，
 *     以 `extends: workloom.questline-base/v1` 继承通用件，由本模块合并并校验。
 * 纪律：装载期校验（fail-closed）——关卡顺序必须是本模块声明的四关、员工卡 ≥3 张、
 * presetKey 唯一、驳回枚举非空；未知 Bundle 返回 null（宁可不引导，也不塞别行业人设）。
 *
 * 注：施工图称「五关」，2026-09-21 产品所有者口径下线基座通用审批后，第 4 关「拍板」整关删除，
 * 业务链路自带关卡（视频管线 G1–G10、定妆照确认）由各自页面就地放行——当前为四关。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import YAML from "yaml";
import { bundlesRoot } from "./assembly.js";

export const QUESTLINE_BASE_VERSION = "workloom.questline-base/v1";
/** 关卡顺序即叙事顺序：认人 → 定方向 → 派活 → 验收（四关；见文件头口径说明） */
export const QUEST_STAGE_IDS = ["meet", "goal", "dispatch", "review"] as const;
export type QuestStageId = (typeof QUEST_STAGE_IDS)[number];

const ScriptSchema = z.object({ enter: z.string().min(1), hint: z.string().min(1), success: z.string().min(1) });

const StageSchema = z.object({
  id: z.enum(QUEST_STAGE_IDS),
  badge: z.string().min(1),
  title: z.string().min(1),
  objective: z.string().min(1),
  primaryLabel: z.string().min(1),
  script: ScriptSchema,
});

const EmployeeCardSchema = z.object({
  id: z.string().min(1),
  presetKey: z.string().min(1),
  title: z.string().min(1),
  duty: z.string().min(1),
  fences: z.array(z.string().min(1)).default([]),
  tasks: z.array(z.string().min(1)).default([]),
  sample: z.string().default(""),
  sampleIsDemo: z.boolean().default(true),
});

const GoalTemplateSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  metric: z.string().min(1),
  ownerPresetKey: z.string().min(1),
  ownerTitle: z.string().min(1),
  artifact: z.string().min(1),
  steps: z.number().int().nonnegative().default(0),
  approvals: z.number().int().nonnegative().default(0),
});

const TaskCardSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  ownerPresetKey: z.string().min(1),
  ownerTitle: z.string().min(1),
  steps: z.number().int().nonnegative().default(0),
  eta: z.string().default(""),
  artifact: z.string().min(1),
  approvals: z.number().int().nonnegative().default(0),
  credits: z.number().nonnegative().default(0),
  dispatchTitle: z.string().min(1),
});

const AchievementSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  hint: z.string().min(1),
  icon: z.enum(["rocket", "team", "tasks", "approval", "celebrate"]),
  stage: z.enum(QUEST_STAGE_IDS),
});

const ValueMetricSchema = z.object({ id: z.string().min(1), label: z.string().min(1), unit: z.string().min(1), source: z.string().min(1) });
const NextStepSchema = z.object({
  id: z.enum(["night_shift", "real_data", "customize"]),
  title: z.string().min(1), desc: z.string().min(1), to: z.string().min(1),
});
const RejectReasonSchema = z.object({ code: z.string().min(1), label: z.string().min(1) });
const VoiceSchema = z.object({ pitch: z.number().optional(), rate: z.number().optional(), female: z.boolean().optional() }).default({});

const BaseSchema = z.object({
  version: z.literal(QUESTLINE_BASE_VERSION),
  journeyName: z.string().min(1),
  mateName: z.string().min(1),
  mateRole: z.string().min(1),
  ownerTitle: z.string().min(1),
  mateVoice: VoiceSchema,
  stages: z.array(StageSchema).min(1),
  achievements: z.array(AchievementSchema).min(1),
  values: z.array(ValueMetricSchema).min(1),
  nextSteps: z.array(NextStepSchema).min(1),
});

const BundlePackSchema = z.object({
  version: z.string().min(1),
  extends: z.literal(QUESTLINE_BASE_VERSION),
  employees: z.array(EmployeeCardSchema).min(3),
  goals: z.array(GoalTemplateSchema).min(1),
  tasks: z.array(TaskCardSchema).min(1),
  rejectReasons: z.array(RejectReasonSchema).min(1),
});

export type QuestlineBase = z.infer<typeof BaseSchema>;
export type QuestlineBundleContent = z.infer<typeof BundlePackSchema>;
export interface QuestlinePack extends QuestlineBundleContent {
  bundleId: string;
  journeyName: string;
  mateName: string;
  mateRole: string;
  ownerTitle: string;
  mateVoice: z.infer<typeof VoiceSchema>;
  stages: z.infer<typeof StageSchema>[];
  achievements: z.infer<typeof AchievementSchema>[];
  values: z.infer<typeof ValueMetricSchema>[];
  nextSteps: z.infer<typeof NextStepSchema>[];
}

export class QuestlinePackError extends Error {
  constructor(public readonly code: "NOT_FOUND" | "BAD_PACK", message: string) {
    super(message);
    this.name = "QuestlinePackError";
  }
}

function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown, source: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new QuestlinePackError("BAD_PACK",
      `${source} 内容包非法：${parsed.error.issues.slice(0, 4).map((i) => `${i.path.join(".")}：${i.message}`).join("；")}`);
  }
  return parsed.data;
}

const baseFile = (root: string): string => join(root, "..", "packages", "base", "bundles", "templates", "questline-base.yml");

/** 装载通用基线（默认 packages/base/bundles/templates/questline-base.yml） */
export function loadQuestlineBase(root = bundlesRoot(), file?: string): QuestlineBase {
  const path = file ?? baseFile(root);
  if (!existsSync(path)) throw new QuestlinePackError("NOT_FOUND", `首日上岗通用基线不存在：${path}`);
  return parseOrThrow(BaseSchema, YAML.parse(readFileSync(path, "utf-8")), path);
}

/** 工作区活动 Bundle → 首日上岗内容包；未知 Bundle / 未声明 → null（宁可不引导） */
export function loadQuestlinePack(bundleId: string | null | undefined, root = bundlesRoot()): QuestlinePack | null {
  const id = (bundleId ?? "").trim();
  if (!id) return null;
  const file = join(root, id, "onboarding", "questline.yml");
  if (!existsSync(file)) return null;
  const content = parseOrThrow(BundlePackSchema, YAML.parse(readFileSync(file, "utf-8")), file);
  const base = loadQuestlineBase(root);
  const stageOrder = content && base.stages.map((s) => s.id);
  if (JSON.stringify(stageOrder) !== JSON.stringify([...QUEST_STAGE_IDS])) {
    throw new QuestlinePackError("BAD_PACK",
      `关卡顺序必须为 ${QUEST_STAGE_IDS.join("→")}（实际 ${stageOrder.join("→")}）：顺序即叙事顺序，改序请先改本模块口径`);
  }
  const presetKeys = content.employees.map((e) => e.presetKey);
  if (new Set(presetKeys).size !== presetKeys.length) {
    throw new QuestlinePackError("BAD_PACK", `员工卡 presetKey 重复：${presetKeys.join(",")}`);
  }
  return { ...content, bundleId: id, ...base, stages: base.stages, achievements: base.achievements, values: base.values, nextSteps: base.nextSteps };
}

/** 关卡定义（按 id 取，找不到抛错：调用方不得静默回落到第一关） */
export function questStageOf(pack: QuestlinePack, stageId: QuestStageId): z.infer<typeof StageSchema> {
  const stage = pack.stages.find((s) => s.id === stageId);
  if (!stage) throw new QuestlinePackError("BAD_PACK", `内容包缺少关卡 ${stageId}`);
  return stage;
}

/** 前哨摘要（日志/门禁用，不含文案） */
export function questlineSummary(pack: QuestlinePack): string {
  return `${pack.bundleId} · ${pack.journeyName}：${pack.stages.length} 关 / 员工卡 ${pack.employees.length} / 目标卡 ${pack.goals.length} / 任务卡 ${pack.tasks.length} / 驳回枚举 ${pack.rejectReasons.length}`;
}
