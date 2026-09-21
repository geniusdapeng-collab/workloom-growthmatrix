import { connectorFetch } from "./http.js";
import {
  ADS_GATEWAY, DOUYIN_LOCAL, OTA_MONITOR, PMS_CONNECTOR, SOCIAL_DOUYIN, WECOM_CONNECTOR,
} from "./registry.js";
import type { ConnectorContext } from "./types.js";

export interface CampaignMetric {
  campaignId: string;
  spendFen: number;
  impressions: number;
  clicks: number;
  conversions: number;
  roi: number;
}

export interface PostMetric {
  postId: string;
  title: string;
  plays: number;
  likes: number;
  comments: number;
  inquiries: number;
}

export interface PostComment {
  commentId: string;
  text: string;
  intent?: string;
  createdAt: string;
}

/** 广告投放数据（Meta / 千川 网关）：增量 ROI 与预算组合的事实来源。 */
export async function fetchCampaignMetrics(
  range: { from: string; to: string }, ctx?: ConnectorContext,
): Promise<{ metrics: CampaignMetric[]; attempts: number }> {
  const { response, attempts } = await connectorFetch(
    ADS_GATEWAY, `/metrics?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`, {}, ctx,
  );
  const body = (await response.json()) as { metrics?: CampaignMetric[] };
  return { metrics: body.metrics ?? [], attempts };
}

/** 内容数据（抖音开放平台）：选题与内容组合的事实来源。 */
export async function fetchPostMetrics(
  range: { from: string; to: string }, ctx?: ConnectorContext,
): Promise<{ posts: PostMetric[]; attempts: number }> {
  const { response, attempts } = await connectorFetch(
    SOCIAL_DOUYIN, `/posts/metrics?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`, {}, ctx,
  );
  const body = (await response.json()) as { posts?: PostMetric[] };
  return { posts: body.posts ?? [], attempts };
}

/** 评论拉取（四档分流的输入；分类仍由行业规则完成，连接器只取原文）。 */
export async function fetchPostComments(
  postId: string, ctx?: ConnectorContext,
): Promise<{ comments: PostComment[]; attempts: number }> {
  const { response, attempts } = await connectorFetch(
    SOCIAL_DOUYIN, `/posts/${encodeURIComponent(postId)}/comments`, {}, ctx,
  );
  const body = (await response.json()) as { comments?: PostComment[] };
  return { comments: body.comments ?? [], attempts };
}

/* ================= B-32：四类真实连接器取数 ================= */

export interface PmsOrderRow {
  orderId: string; roomTypeId: string; checkIn: string; checkOut: string; status: string; amountFen: number;
}

export async function fetchPmsOrders(
  range: { from: string; to: string }, ctx?: ConnectorContext,
): Promise<{ orders: PmsOrderRow[]; attempts: number }> {
  const { response, attempts } = await connectorFetch(
    PMS_CONNECTOR, `/pms/orders?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`, {}, ctx,
  );
  const body = (await response.json()) as { orders?: PmsOrderRow[] };
  return { orders: body.orders ?? [], attempts };
}

export interface OtaPriceRow {
  platform: string; roomTypeId: string; date: string; priceFen: number;
}

export interface OtaReviewRow {
  platform: string; reviewId: string; rating: number; text: string; createdAt: string;
}

export async function fetchOtaPrices(
  range: { from: string; to: string }, ctx?: ConnectorContext,
): Promise<{ prices: OtaPriceRow[]; attempts: number }> {
  const { response, attempts } = await connectorFetch(
    OTA_MONITOR, `/ota/prices?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`, {}, ctx,
  );
  const body = (await response.json()) as { prices?: OtaPriceRow[] };
  return { prices: body.prices ?? [], attempts };
}

export async function fetchOtaReviews(
  range: { from: string; to: string }, ctx?: ConnectorContext,
): Promise<{ reviews: OtaReviewRow[]; attempts: number }> {
  const { response, attempts } = await connectorFetch(
    OTA_MONITOR, `/ota/reviews?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`, {}, ctx,
  );
  const body = (await response.json()) as { reviews?: OtaReviewRow[] };
  return { reviews: body.reviews ?? [], attempts };
}

export interface WecomLeadRow {
  leadId: string; /** 已由连接器侧脱敏（R24：明文不出客户系统） */
  contactMasked: string; intent: string; createdAt: string;
}

export async function fetchWecomLeads(
  range: { from: string; to: string }, ctx?: ConnectorContext,
): Promise<{ leads: WecomLeadRow[]; attempts: number }> {
  const { response, attempts } = await connectorFetch(
    WECOM_CONNECTOR, `/wecom/leads?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`, {}, ctx,
  );
  const body = (await response.json()) as { leads?: WecomLeadRow[] };
  return { leads: body.leads ?? [], attempts };
}

export interface DouyinRedemptionRow {
  redemptionId: string; couponId: string; verifiedAt: string; amountFen: number;
}

export async function fetchDouyinLocalRedemptions(
  range: { from: string; to: string }, ctx?: ConnectorContext,
): Promise<{ redemptions: DouyinRedemptionRow[]; attempts: number }> {
  const { response, attempts } = await connectorFetch(
    DOUYIN_LOCAL, `/douyin-local/redemptions?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`, {}, ctx,
  );
  const body = (await response.json()) as { redemptions?: DouyinRedemptionRow[] };
  return { redemptions: body.redemptions ?? [], attempts };
}
