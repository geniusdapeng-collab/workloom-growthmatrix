/**
 * service · 信任账户接入运行（B-72）
 *
 * 信任账户（packages/base/captain/trust.ts）此前只被 `scripts/metrics.mts` 读着看，不进运行：
 * 升降档建议没人接、降档不收紧、补考无单据。本模块把它接进运行时，三条闭环：
 *
 *  ① **降档自动收紧**（收紧方向不需要人批）：命中降档时，把该决策域对口的自治项收窄——
 *     caps 减半、ranges 向 anchor 收窄一半；若自治项里没有对口项，则**不假装收紧**，
 *     事件里如实记 `tightened: false` 与原因（宁可说没做，也不虚报）；
 *  ② **升档建议进决策包**：升档必须人批，因此落一道 pending 关卡（approvals，tier=l3_fleet），
 *     决策包/晨报按现有口径读到它；
 *  ③ **补考闭环**：红线事故降档 → 落 `trust.retake.required` 事件 + 一道 pending 关卡
 *     （「复考：<域>」），由人安排考试院复考；复考通过路径仍走考试院既有晋升门禁。
 *
 * 每次运行写一条 `trust.reviewed` 快照事件（各域档位/样本/依据），供晨报与审计复算。
 */
import type pg from "pg";
import {
  buildTrustAccounts, effectiveAutonomy, loadCharter, saveCharter,
  DEFAULT_TRUST_POLICY, type Charter, type DomainEvidence, type TrustVerdict,
} from "@workloom/base/captain";
import { appendEventOn, serviceTx, svcQuery } from "./events.js";

type Actor = { id: string; type: "human" | "agent" | "system" };

export interface TrustDomainReview {
  domain: string;
  level: TrustVerdict["level"];
  sample: number;
  hitRate: number | null;
  approveRate: number | null;
  retakeRequired: boolean;
  tightened: boolean;
  tightenedKeys: string[];
  reason: string;
}

export interface TrustReviewResult {
  reviewed: TrustDomainReview[];
  events: string[];
  gates: string[];
}

/** 域 → 自治项的对口匹配（大小写无关的包含匹配，避免"price"配到"price_history"这类误伤由人工复核） */
export function matchingAutonomyKeys(domain: string, autonomy: Charter["autonomy"]): { caps: string[]; ranges: string[] } {
  const needle = domain.trim().toLowerCase();
  if (!needle) return { caps: [], ranges: [] };
  const caps = Object.keys(autonomy.caps).filter((k) => k.toLowerCase().includes(needle) || needle.includes(k.toLowerCase()));
  const ranges = Object.keys(autonomy.ranges).filter((k) => k.toLowerCase().includes(needle) || needle.includes(k.toLowerCase()));
  return { caps, ranges };
}

/** 收窄一档：caps 减半；ranges 向 anchor 收窄一半（与 charter.tightenAutonomy 同口径，但只作用于命中项） */
export function tightenDomains(charter: Charter, domains: string[]): { charter: Charter; tightenedKeys: string[] } {
  const next = structuredClone(charter);
  const tightenedKeys: string[] = [];
  for (const domain of domains) {
    const keys = matchingAutonomyKeys(domain, next.autonomy);
    for (const key of keys.caps) {
      const cap = next.autonomy.caps[key]!;
      const limit = Number((cap.limit / 2).toFixed(4));
      if (limit < cap.limit) { next.autonomy.caps[key] = { ...cap, limit }; tightenedKeys.push(`cap:${key}`); }
    }
    for (const key of keys.ranges) {
      const range = next.autonomy.ranges[key]!;
      const lower = Number((range.anchor - (range.anchor - range.lower) / 2).toFixed(4));
      const upper = Number((range.anchor + (range.upper - range.anchor) / 2).toFixed(4));
      if (lower > range.lower || upper < range.upper) {
        next.autonomy.ranges[key] = { ...range, lower, upper };
        tightenedKeys.push(`range:${key}`);
      }
    }
  }
  return { charter: next, tightenedKeys: [...new Set(tightenedKeys)] };
}

/** 最近一次信任快照（供晨报/界面读；无快照返回空数组，不编数） */
export async function latestTrustSnapshot(workspaceId: string): Promise<{
  eventId: string; at: string; domains: TrustDomainReview[];
} | null> {
  const rows = await svcQuery<{ event_id: string; created_at: string; after: { reviewed?: TrustDomainReview[] } | null }>(workspaceId,
    `SELECT event_id, created_at, payload->'decision'->'after' AS after FROM biz_events
      WHERE workspace_id=$1 AND payload->'decision'->>'action'='trust.reviewed'
      ORDER BY seq DESC LIMIT 1`,
    [workspaceId]);
  const row = rows[0];
  if (!row) return null;
  return {
    eventId: row.event_id,
    at: typeof row.created_at === "string" ? row.created_at : new Date(row.created_at).toISOString(),
    domains: row.after?.reviewed ?? [],
  };
}

/**
 * 跑一轮信任复核并落地：降档自动收紧 + 升档/补考进关卡 + 快照事件。
 * @param opts.dryRun 只算不改（演练/验收用）：返回建议但不写库。
 */
export async function runTrustReview(
  workspaceId: string, actor: Actor, opts: { dryRun?: boolean; policy?: typeof DEFAULT_TRUST_POLICY } = {},
): Promise<TrustReviewResult> {
  const app = await import("@workloom/db").then((m) => m.getAppPool());
  const accounts = await buildTrustAccounts(app, { tenantId: await tenantOf(workspaceId), workspaceId }, opts.policy ?? DEFAULT_TRUST_POLICY);
  if (accounts.length === 0) return { reviewed: [], events: [], gates: [] };

  const reviews: TrustDomainReview[] = accounts.map(({ evidence, verdict }) => ({
    domain: verdict.domain,
    level: verdict.level,
    sample: verdict.sample,
    hitRate: verdict.hitRate,
    approveRate: verdict.approveRate,
    retakeRequired: verdict.retakeRequired,
    tightened: false,
    tightenedKeys: [],
    reason: verdict.reasons.join("；"),
  }));
  if (opts.dryRun) return { reviewed: reviews, events: [], gates: [] };

  const downDomains = reviews.filter((r) => r.level === "down").map((r) => r.domain);
  const upDomains = reviews.filter((r) => r.level === "up");
  const retakeDomains = reviews.filter((r) => r.retakeRequired).map((r) => r.domain);

  const events: string[] = [];
  const gates: string[] = [];
  await serviceTx(workspaceId, async (client, scope) => {
    // ① 降档自动收紧（收紧方向免人批；无对口自治项则如实记录未收紧）
    if (downDomains.length > 0) {
      const charter = await loadCharter(app, scope);
      const before = JSON.stringify(charter.autonomy);
      const { charter: tightened, tightenedKeys } = tightenDomains(charter, downDomains);
      if (tightenedKeys.length > 0 && JSON.stringify(tightened.autonomy) !== before) {
        tightened.updated_at = new Date().toISOString();
        await saveCharter(client, scope, tightened);
        for (const review of reviews) {
          if (review.level !== "down") continue;
          const keys = matchingAutonomyKeys(review.domain, tightened.autonomy);
          const hit = tightenedKeys.filter((k) => keys.caps.includes(k.slice(4)) || keys.ranges.includes(k.slice(6)));
          review.tightened = hit.length > 0;
          review.tightenedKeys = hit;
          if (!review.tightened) review.reason += "；自治项无对口项（未收紧，需人审补齐口径）";
        }
        const ev = await appendEventOn(client, scope, actor, {
          objectType: "company_ceo", objectId: scope.workspaceId, action: "trust.autonomy_tightened",
          after: { domains: downDomains, tightenedKeys, basis: "信任账户降档：收紧方向免人批（B-72）" },
        });
        events.push(ev.eventId);
      } else {
        for (const review of reviews) {
          if (review.level === "down") review.reason += "；自治项无对口项（未收紧，需人审补齐口径）";
        }
      }
    }

    // ② 升档建议进决策包：落 pending 关卡（人批后才可升档）
    for (const review of upDomains) {
      const gateId = `apr-trust-up-${review.domain}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 60);
      const ev = await appendEventOn(client, scope, actor, {
        objectType: "company_ceo", objectId: scope.workspaceId, action: "trust.upgrade_proposed",
        after: { domain: review.domain, sample: review.sample, hitRate: review.hitRate, approveRate: review.approveRate, reason: review.reason },
      });
      events.push(ev.eventId);
      await client.query(
        `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, tier, snapshot)
         VALUES ($1,$2,$3,$4,'inapp','pending','l3_fleet',$5)
         ON CONFLICT (event_id, channel) DO NOTHING`,
        [gateId, scope.tenantId, scope.workspaceId, ev.eventId, JSON.stringify({
          action: "trust.upgrade", title: `信任升档建议：${review.domain}`.slice(0, 200),
          high_risk: false, domain: review.domain, sample: review.sample,
          hitRate: review.hitRate, approveRate: review.approveRate,
        })],
      );
      gates.push(gateId);
    }

    // ③ 补考闭环：红线事故降档 → 复考单进队列（考试院既有晋升门禁仍生效）
    for (const domain of retakeDomains) {
      const retakeGateId = `apr-trust-retake-${domain}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 60);
      const ev = await appendEventOn(client, scope, actor, {
        objectType: "company_ceo", objectId: scope.workspaceId, action: "trust.retake.required",
        after: {
          domain, reason: "红线事故：降档并补考（信任账户 v0 规则）",
          nextStep: "安排考试院复考；复考通过后按晋升门禁恢复档位",
        },
      });
      events.push(ev.eventId);
      await client.query(
        `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, tier, snapshot)
         VALUES ($1,$2,$3,$4,'inapp','pending','l3_fleet',$5)
         ON CONFLICT (event_id, channel) DO NOTHING`,
        [retakeGateId, scope.tenantId, scope.workspaceId, ev.eventId, JSON.stringify({
          action: "trust.retake", title: `复考：${domain}（红线事故降档）`.slice(0, 200),
          high_risk: false, domain, retake: true,
        })],
      );
      gates.push(retakeGateId);
    }

    // ④ 快照事件：各域档位/样本/依据（晨报与审计读它）
    const snapshot = await appendEventOn(client, scope, actor, {
      objectType: "company_ceo", objectId: scope.workspaceId, action: "trust.reviewed",
      after: {
        reviewed: reviews,
        counts: {
          down: reviews.filter((r) => r.level === "down").length,
          up: reviews.filter((r) => r.level === "up").length,
          hold: reviews.filter((r) => r.level === "hold").length,
        },
        policy: opts.policy ?? DEFAULT_TRUST_POLICY,
      },
    });
    events.push(snapshot.eventId);
  });

  return { reviewed: reviews, events, gates };
}

async function tenantOf(workspaceId: string): Promise<string> {
  const rows = await svcQuery<{ tenant_id: string }>(workspaceId, `SELECT tenant_id FROM workspaces WHERE id=$1`, [workspaceId]);
  const tenantId = rows[0]?.tenant_id;
  if (!tenantId) throw new Error(`工作区不存在：${workspaceId}`);
  return tenantId;
}

export type { DomainEvidence, TrustVerdict };
export { effectiveAutonomy };
