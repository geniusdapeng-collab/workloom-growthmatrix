/**
 * B-63：服务端内容包 → 客户端渲染结构（内容随 Bundle 分发的落地桥）。
 *
 * 数据流：`bundles/<id>/onboarding/questline.yml` → 服务端 `onboarding.questline` →
 * 本模块映射为客户端 `QuestlineConfig`。客户端本地仍保留 questline.config.ts 作为
 * 离线兜底（服务端不可达时页面照常可用），但**在线时以包为准**——改内容不必发前端。
 * 音色档案（VoiceProfile）属本机音频资产，不随包下发，仍用 MATE_GUIDE_VOICE。
 */
import type { QuestlineConfig } from "./questline.config";
import { MATE_GUIDE_VOICE } from "./questline.config";

/** 服务端内容包的最小结构（只声明用得到的字段，避免与后端 zod 类型耦合） */
export interface ServerQuestlinePack {
  bundleId: string;
  journeyName: string;
  mateName: string;
  mateRole: string;
  ownerTitle: string;
  stages: QuestlineConfig["stages"];
  employees: QuestlineConfig["employees"];
  goals: QuestlineConfig["goals"];
  tasks: QuestlineConfig["tasks"];
  achievements: QuestlineConfig["achievements"];
  values: QuestlineConfig["values"];
  nextSteps: QuestlineConfig["nextSteps"];
  rejectReasons: QuestlineConfig["rejectReasons"];
}

export function questlineConfigFromPack(pack: ServerQuestlinePack | null | undefined): QuestlineConfig | null {
  if (!pack || !Array.isArray(pack.stages) || pack.stages.length === 0) return null;
  if (!Array.isArray(pack.employees) || pack.employees.length < 3) return null;
  return {
    journeyName: pack.journeyName,
    mateName: pack.mateName,
    mateRole: pack.mateRole,
    ownerTitle: pack.ownerTitle,
    mateVoice: MATE_GUIDE_VOICE,
    stages: pack.stages,
    employees: pack.employees,
    goals: pack.goals,
    tasks: pack.tasks,
    achievements: pack.achievements,
    values: pack.values,
    nextSteps: pack.nextSteps,
    rejectReasons: pack.rejectReasons,
  };
}
