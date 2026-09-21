/**
 * social-listening/scheduler —— 真实采集调度接线（B-54）
 *
 * 把连接器（B-32 抖音开放平台）取到的内容指标映射为 account_metrics 落账条目，
 * 再走既有的 recordMetrics + checkThresholds；未配置连接器时 fail-closed 返回 unconfigured
 * （不回退 mock、不写假数据），并可检测指标陈旧（供看门狗 B-35 引用）。
 */
import type pg from "pg";
import { ConnectorUnconfiguredError, fetchPostMetrics, type PostMetric } from "../connectors/index.js";
import { checkThresholds, recordMetrics, type MetricEntry, type ThresholdAlert, type ThresholdRule } from "./metrics.js";

export interface CollectionTickOptions {
  range: { from: string; to: string };
  rules: ThresholdRule[];
  platform?: string;
  accountId: string;
  capturedAt?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export interface CollectionTickResult {
  status: "collected" | "unconfigured" | "failed";
  collected: number;
  alerts: ThresholdAlert[];
  message: string;
}

/** 内容指标 → account_metrics 条目（平台侧询盘计为 conversions 代理口径，表注可查）。 */
export function metricEntriesFromPosts(
  posts: PostMetric[], opts: { platform: string; accountId: string; capturedAt: string },
): MetricEntry[] {
  return posts.map((post) => ({
    platform: opts.platform,
    accountId: opts.accountId,
    videoId: post.postId,
    capturedAt: opts.capturedAt,
    plays: post.plays,
    likes: post.likes,
    comments: post.comments,
    shares: 0,
    conversions: post.inquiries,
  }));
}

export function stalenessOf(
  latestCapturedAt: string | null, now = new Date(), maxAgeHours = 3,
): { stale: boolean; ageHours: number | null } {
  if (!latestCapturedAt) return { stale: true, ageHours: null };
  const at = new Date(latestCapturedAt).getTime();
  if (Number.isNaN(at)) return { stale: true, ageHours: null };
  const ageHours = (now.getTime() - at) / 3_600_000;
  return { stale: ageHours > maxAgeHours, ageHours: Number(ageHours.toFixed(2)) };
}

export async function runCollectionTick(
  app: pg.Pool, gateway: pg.Pool, scope: { tenantId: string; workspaceId: string }, opts: CollectionTickOptions,
): Promise<CollectionTickResult> {
  try {
    const { posts } = await fetchPostMetrics(opts.range, { env: opts.env, fetchImpl: opts.fetchImpl });
    const entries = metricEntriesFromPosts(posts, {
      platform: opts.platform ?? "douyin",
      accountId: opts.accountId,
      capturedAt: opts.capturedAt ?? new Date().toISOString(),
    });
    const collected = await recordMetrics(app, gateway, scope, entries);
    const alerts = entries.length > 0 ? await checkThresholds(app, gateway, scope, opts.rules) : [];
    return { status: "collected", collected, alerts, message: `采集 ${collected} 条内容指标` };
  } catch (error) {
    if (error instanceof ConnectorUnconfiguredError) {
      return {
        status: "unconfigured", collected: 0, alerts: [],
        message: `连接器未配置（${error.missing.join("、")}）：fail-closed，不回退 mock`,
      };
    }
    return {
      status: "failed", collected: 0, alerts: [],
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
