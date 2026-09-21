/**
 * collaboration/dispatch —— 五模式执行器（B-36）
 *
 * 五种协作模式的确定性编排（线程生成 / 串行推进 / 黑板主写者 / 契约流转 / 战役编组）：
 *  - 纯函数：同输入同计划，可单测、可回放；
 *  - 每种模式有硬性参与人约束（人数/角色），不满足直接拒绝（不静默降级成单人模式）；
 *  - m3 黑板模式强制「单主写者」：任何时刻只允许一个 owner 写入，其他角色只读或走契约。
 */
import type { CollaborationMode } from "./schema.js";

export interface DispatchInput {
  mode: CollaborationMode;
  goal: string;
  /** 参与岗位（preset_key）；角色含义随模式而定 */
  participants: string[];
  /** m2 管线阶段名（≥2）；m5 战役工作流名（≥2） */
  stages?: string[];
  /** m3 黑板主题 */
  boardTopic?: string;
  deadline?: string | null;
  budgetAmount?: number;
}

export type LaneKind = "work" | "handoff" | "verify" | "coordinate";

export interface DispatchLane {
  id: string;
  owner: string;
  kind: LaneKind;
  /** 依赖的 lane id（串行推进/编组排序） */
  dependsOn: string[];
  deliverable: string;
}

export interface DispatchPlan {
  mode: CollaborationMode;
  goal: string;
  lanes: DispatchLane[];
  rules: string[];
  /** m3 黑板唯一主写者 */
  blackboardWriter?: string;
  deadline: string | null;
  budgetAmount: number;
}

const requireParticipants = (input: DispatchInput, min: number, max = Number.POSITIVE_INFINITY): void => {
  if (input.participants.length < min) {
    throw new Error(`${input.mode} 需要至少 ${min} 名参与岗位，实际 ${input.participants.length}`);
  }
  if (input.participants.length > max) {
    throw new Error(`${input.mode} 最多允许 ${max} 名参与岗位，实际 ${input.participants.length}`);
  }
  if (new Set(input.participants).size !== input.participants.length) {
    throw new Error(`${input.mode} 参与岗位重复（同一岗位不能在同一计划中占多个角色）`);
  }
};

/** 生成五模式执行计划；输入不满足模式约束时抛错（fail-closed）。 */
export function planDispatch(input: DispatchInput): DispatchPlan {
  if (!input.goal.trim()) throw new Error("协作计划必须有目标");
  const base = { mode: input.mode, goal: input.goal.trim(), deadline: input.deadline ?? null, budgetAmount: input.budgetAmount ?? 0 };
  switch (input.mode) {
    case "m1_single": {
      requireParticipants(input, 1, 1);
      return {
        ...base,
        lanes: [{ id: "work", owner: input.participants[0]!, kind: "work", dependsOn: [], deliverable: "目标交付物 + 回执" }],
        rules: ["单人闭环：产出必须带回执（无回执不算完成）", "写动作仍过围栏瀑布"],
      };
    }
    case "m2_pipeline": {
      requireParticipants(input, 2);
      const stages = input.stages ?? [];
      if (stages.length < 2 || stages.length !== input.participants.length) {
        throw new Error("m2_pipeline 需要与参与岗位一一对应的 ≥2 个阶段名");
      }
      const lanes = input.participants.map((owner, i) => ({
        id: `stage-${i + 1}-${stages[i]}`,
        owner,
        kind: (i === 0 ? "work" : "handoff") as LaneKind,
        dependsOn: i === 0 ? [] : [`stage-${i}-${stages[i - 1]}`],
        deliverable: `阶段「${stages[i]}」交付物 + 交接回执`,
      }));
      return {
        ...base,
        lanes,
        rules: ["严格串行：上一阶段无交接回执，下一阶段不得开工", "阶段回执含证据与质量标记", "任一阶段失败即整体挂起转人工"],
      };
    }
    case "m3_blackboard": {
      requireParticipants(input, 2);
      const writer = input.participants[0]!;
      const topic = input.boardTopic?.trim() || "共享黑板";
      const lanes = input.participants.map((owner, i) => ({
        id: i === 0 ? "blackboard-write" : `blackboard-read-${owner}`,
        owner,
        kind: (i === 0 ? "coordinate" : "work") as LaneKind,
        dependsOn: [],
        deliverable: i === 0 ? `黑板「${topic}」唯一写者：聚合各方只读产出` : "只读分析：产出建议，不直接写黑板",
      }));
      return {
        ...base,
        lanes,
        blackboardWriter: writer,
        rules: [
          `单主写者：${writer} 是黑板「${topic}」唯一写入者`,
          "其他角色只读并输出建议；需落写的内容走契约交给主写者",
          "版本单调：黑板每次写入带版本号，冲突由主写者串行裁决",
        ],
      };
    }
    case "m4_contract": {
      requireParticipants(input, 3);
      const [requester, assignee, verifier] = input.participants as [string, string, string];
      return {
        ...base,
        lanes: [
          { id: "contract-offer", owner: requester, kind: "coordinate", dependsOn: [], deliverable: "契约（目标/判据/预算/期限）" },
          { id: "contract-work", owner: assignee, kind: "work", dependsOn: ["contract-offer"], deliverable: "交付物 + 交付回执" },
          { id: "contract-verify", owner: verifier, kind: "verify", dependsOn: ["contract-work"], deliverable: "验收结论（通过/退回 + 证据）" },
        ],
        rules: [
          "契约状态机 draft→offered→accepted→in_progress→delivered→verified→settled",
          "无验收不得结算（无回执不算完成）",
          "退回必须给可复现理由；预算超带升级 L4",
        ],
      };
    }
    case "m5_campaign": {
      requireParticipants(input, 3);
      const stages = input.stages ?? [];
      if (stages.length < 2) throw new Error("m5_campaign 需要 ≥2 条工作流名");
      const [coordinator, ...streams] = input.participants as [string, ...string[]];
      const lanes: DispatchLane[] = [
        { id: "campaign-coordinate", owner: coordinator, kind: "coordinate", dependsOn: [], deliverable: "战役里程碑与资源编排" },
        ...streams.map((owner, i) => ({
          id: `stream-${i + 1}-${stages[i % stages.length]}`,
          owner,
          kind: "work" as LaneKind,
          dependsOn: ["campaign-coordinate"],
          deliverable: `工作流「${stages[i % stages.length]}」交付物 + 战报栏位`,
        })),
      ];
      return {
        ...base,
        lanes,
        rules: ["战役编组：各工作流并行推进，里程碑由协调岗验收", "每日战报汇总各流进度；预算/投放仍走 L4", "任一工作流熔断即暂停编组并升级"],
      };
    }
    default: {
      const exhaustive: never = input.mode;
      throw new Error(`未知协作模式 ${String(exhaustive)}`);
    }
  }
}

/** m3 单主写者守卫：非主写者尝试写入 → 拒绝（应改走契约）。 */
export function blackboardWriteGuard(plan: DispatchPlan, actor: string): { ok: boolean; reason?: string } {
  if (plan.mode !== "m3_blackboard" || !plan.blackboardWriter) {
    return { ok: false, reason: "该计划不是黑板块协作" };
  }
  if (actor !== plan.blackboardWriter) {
    return { ok: false, reason: `黑板单主写者=${plan.blackboardWriter}，${actor} 只能只读或走契约` };
  }
  return { ok: true };
}

export function summarizeDispatch(plan: DispatchPlan): string {
  const byKind = new Map<LaneKind, number>();
  for (const lane of plan.lanes) byKind.set(lane.kind, (byKind.get(lane.kind) ?? 0) + 1);
  return `${plan.mode}：${plan.lanes.length} 条泳道（${[...byKind.entries()].map(([k, n]) => `${k}×${n}`).join(" · ")}）`
    + `｜规则 ${plan.rules.length} 条${plan.blackboardWriter ? `｜主写者 ${plan.blackboardWriter}` : ""}`;
}
