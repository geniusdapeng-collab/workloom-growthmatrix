/**
 * base/captain · 首登行动卡（B-64）
 *
 * 「今天要做哪三件事」——客户首次登录（或每天首次打开）看到的固定卡：
 *  ① 待放行关卡（真实 approvals 队列，L4 优先）；
 *  ② 首日上岗续播（未完成时给下一步；已完成则不再出现）；
 *  ③ 待验收交付（线程在待复核/运行态）。
 * 纪律：
 *  - 纯函数：事实由调用方从账本/队列/线程表取，本模块不猜数；
 *  - 上限三件（产品口径「今天三件事」），按优先级截断，不放"顺手推荐"占位；
 *  - 每件都带 source（事实出处）与 to（去哪办），空事实就不出卡（宁可不打卡，也不编任务）。
 */

export interface ActionCardGate {
  approvalId: string;
  title: string;
  tier: "l2_captain" | "l3_fleet" | "l4_chairman" | string;
  ageHours: number;
  action?: string | null;
  objectType?: string | null;
  objectId?: string | null;
}

export interface ActionCardFacts {
  /** 首日上岗进度（未装内容包为 null） */
  questline: {
    journeyName: string;
    /** 当前关卡展示名（如「第 2 关 · 今天最想解决的一件事」） */
    stageTitle: string;
    stageIndex: number;
    totalStages: number;
    completed: boolean;
  } | null;
  /** 待放行关卡（真实队列，≤ 调用方读取上限） */
  pendingGates: ActionCardGate[];
  /** 线程面事实 */
  threads: { running: number; pendingReview: number };
  /** 最新晨报（有则可提示"今日战报已生成"） */
  briefing: { eventId: string; text: string } | null;
}

export interface ActionCardItem {
  id: string;
  title: string;
  why: string;
  to: string;
  /** 事实出处（界面必须显示，不允许无出处的数字） */
  source: string;
}

export interface ActionCard {
  version: "action-card/v1";
  generatedAt: string;
  items: ActionCardItem[];
  pendingGates: ActionCardGate[];
}

const TIER_RANK: Record<string, number> = { l4_chairman: 3, l3_fleet: 2, l2_captain: 1 };
const tierLabel = (tier: string): string => (tier === "l4_chairman" ? "董事长" : tier === "l3_fleet" ? "集团" : "主管");

export function buildActionCard(facts: ActionCardFacts, opts: { now?: Date; maxItems?: number } = {}): ActionCard {
  const now = opts.now ?? new Date();
  const maxItems = opts.maxItems ?? 3;
  const gates = [...facts.pendingGates].sort((a, b) => {
    const tier = (TIER_RANK[b.tier] ?? 0) - (TIER_RANK[a.tier] ?? 0);
    if (tier !== 0) return tier;
    return b.ageHours - a.ageHours;
  });
  const items: ActionCardItem[] = [];

  if (gates.length > 0) {
    const top = gates[0]!;
    items.push({
      id: "gate-first",
      title: gates.length === 1
        ? `放行：${top.title}`.slice(0, 60)
        : `放行 ${gates.length} 件待办（第一件：${top.title}）`.slice(0, 60),
      why: `${tierLabel(top.tier)}级关卡，已等 ${Math.max(0, Math.round(top.ageHours))} 小时；不放行则对应动作不会执行`,
      to: "/executive",
      source: "业务关卡队列（approvals，待放行）",
    });
  }

  if (facts.questline && !facts.questline.completed) {
    items.push({
      id: "questline-resume",
      title: `继续${facts.questline.journeyName}：第 ${facts.questline.stageIndex + 1}/${facts.questline.totalStages} 关`.slice(0, 60),
      why: `${facts.questline.stageTitle}（进度按账号保存，换设备也能接着走）`,
      to: "/",
      source: "首日上岗进度（服务端 onboarding_progress）",
    });
  }

  if (facts.threads.pendingReview > 0) {
    items.push({
      id: "threads-verify",
      title: `验收 ${facts.threads.pendingReview} 件交付`,
      why: "数字员工已交付、等您确认；未验收不算完成（无回执不算完成）",
      to: "/threads",
      source: "任务线程（threads，待复核）",
    });
  } else if (facts.threads.running > 0) {
    items.push({
      id: "threads-running",
      title: `跟进 ${facts.threads.running} 件在办任务`,
      why: "班组正在执行；完成会进您的验收队列",
      to: "/threads",
      source: "任务线程（threads，运行中）",
    });
  }

  if (items.length < maxItems && facts.briefing) {
    items.push({
      id: "briefing-read",
      title: "看今日战报（已生成）",
      why: "昨天的动作、风险与待您拍板事项都在里面",
      to: "/executive",
      source: `晨报事件 ${facts.briefing.eventId}`,
    });
  }

  return {
    version: "action-card/v1",
    generatedAt: now.toISOString(),
    items: items.slice(0, maxItems),
    pendingGates: gates.slice(0, 5),
  };
}
