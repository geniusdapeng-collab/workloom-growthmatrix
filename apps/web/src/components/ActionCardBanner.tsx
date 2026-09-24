/**
 * 首登行动卡通栏（B-64 · 客户端落地）
 *
 * 数据源 = `onboarding.actionCard`（服务端按真实事实组装：待放行关卡 / 首日上岗续播 / 待验收交付 / 晨报）。
 * 为什么是通栏而不是主视图大卡：2026-09-20 产品所有者口径要求主视图保持纯粹（顶部状态行/任务卡已删），
 * 与 SimBanner / SkillDistBanner 同位的**通栏**是既有惯例：一行说清「今天待决几件」，点进去就办。
 *
 * 纪律：
 *  - 只显示服务端给的事实（每件都带 source 出处），不编造待办；
 *  - 没有待办就不渲染（不打扰）；
 *  - 服务端不可用 → 一行轻提示 + 重试（不阻塞页面其他功能）；
 *  - 当日可关闭（localStorage 按日记忆，次日新事项再出现）。
 */
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@workloom/ui";
import { ensureDemoLogin, trpc } from "../lib/trpc";

interface ActionCardItem { id: string; title: string; why: string; to: string; source: string }
interface ActionCardGate { approvalId: string; title: string; tier: string; ageHours: number }
interface ActionCardPayload {
  version: string;
  generatedAt: string;
  items: ActionCardItem[];
  pendingGates: ActionCardGate[];
}

const dismissKey = (day: string) => `action-card-dismissed:${day}`;
const TIER_LABEL: Record<string, string> = { l4_chairman: "董事长级", l3_fleet: "集团级", l2_captain: "主管级" };

export function ActionCardBanner() {
  const [card, setCard] = useState<ActionCardPayload | null>(null);
  const [failed, setFailed] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const load = useCallback(async () => {
    try {
      await ensureDemoLogin();
      const r = (await trpc.onboarding.actionCard.query()) as ActionCardPayload;
      setCard(r);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => { void load(); const id = setInterval(() => void load(), 60_000); return () => clearInterval(id); }, [load]);
  useEffect(() => {
    const day = new Date().toISOString().slice(0, 10);
    setDismissed(localStorage.getItem(dismissKey(day)) === "1");
  }, []);

  const dismiss = () => {
    localStorage.setItem(dismissKey(new Date().toISOString().slice(0, 10)), "1");
    setDismissed(true);
  };

  if (dismissed) return null;
  if (failed) {
    return (
      <div className="relative z-30 flex items-center gap-3 border-b border-amber-500/40 bg-amber-50/80 px-4 py-1.5 text-body text-amber-800 backdrop-blur">
        <Icon name="warning" size={14} />
        <span className="flex-1">行动卡暂时不可用（不影响其他功能）</span>
        <button onClick={() => void load()} className="shrink-0 cursor-pointer rounded border border-amber-500/50 px-2 py-0.5 hover:bg-amber-100">
          重试
        </button>
      </div>
    );
  }
  if (!card) return null;
  const items = card.items ?? [];
  const gates = card.pendingGates ?? [];
  if (items.length === 0 && gates.length === 0) return null;

  const head = gates.length > 0
    ? `今日待决 ${gates.length} 件`
    : `今日待办 ${items.length} 件`;
  const detail = items.slice(0, 2).map((i) => i.title).join(" · ");
  const more = items.length > 2 ? ` 等 ${items.length} 件` : "";
  const top = items[0];
  const firstGate = gates[0];
  const tierHint = firstGate ? `（最高 ${TIER_LABEL[firstGate.tier] ?? firstGate.tier}）` : "";

  return (
    <div data-action-card className="relative z-30 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-gold/40 bg-gold/10 px-4 py-2 text-body text-ink backdrop-blur">
      <Icon name="play" size={16} />
      <span className="min-w-0 flex-1" title={top ? `${top.title}｜${top.why}（出处：${top.source}）` : undefined}>
        <b>{head}</b>{tierHint}：{detail}{more}
        {top ? <span className="text-ink3">（{top.source}）</span> : null}
      </span>
      {top && (
        <a href={top.to} className="shrink-0 rounded border border-gline bg-bg900/60 px-3 py-1 font-bold text-gold no-underline transition-colors hover:bg-bg800/70">
          去处理 →
        </a>
      )}
      <button
        onClick={dismiss}
        className="shrink-0 cursor-pointer rounded px-2 py-1 text-ink3 transition-colors hover:bg-bg800/60"
        aria-label="今日不再提示"
        title="今日不再提示"
      >
        <Icon name="close" size={15} />
      </button>
    </div>
  );
}
