-- 0044_growth_daily_security_invoker.sql · B-79 修正
-- 事故：growth_daily 视图默认以「视图属主」权限执行，workloom_app 查询会绕过 account_growth_daily 的 RLS
-- （实测未设 GUC 时返回全部 14 行）。改为 security_invoker 视图：RLS 按查询者身份生效。
CREATE OR REPLACE VIEW growth_daily
  WITH (security_invoker = true)
AS
SELECT g.workspace_id, g.platform, g.account_id, g.day,
       g.fans_delta, g.interactions, g.private_adds,
       g.wakeup_conversions, g.repurchase_count, g.referral_count,
       g.source,
       COALESCE(m.plays, 0)::bigint AS plays,
       COALESCE(m.measured_interactions, 0)::bigint AS measured_interactions
  FROM account_growth_daily g
  LEFT JOIN (
    SELECT workspace_id, platform, account_id, captured_at::date AS day,
           sum(plays) AS plays, sum(likes + comments + shares) AS measured_interactions
      FROM account_metrics
     WHERE video_id IS NULL
     GROUP BY 1,2,3,4
  ) m
    ON m.workspace_id = g.workspace_id AND m.platform = g.platform
   AND m.account_id = g.account_id AND m.day = g.day;

GRANT SELECT ON growth_daily TO workloom_app, workloom_gateway;
