-- 0043_growth_daily.sql · B-33 增长日表（粉丝/互动/私域/唤醒/复购/转介）
-- 与 account_metrics（平台采集）并列：account_metrics 是原始时序，account_growth_daily 是
-- 「增长五项」日聚合事实源；growth_daily 视图把两者对齐到日粒度，供周表与战报复算。
CREATE TABLE IF NOT EXISTS account_growth_daily (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id),
  platform            TEXT NOT NULL,
  account_id          TEXT NOT NULL,
  day                 DATE NOT NULL,
  fans_delta          INTEGER NOT NULL DEFAULT 0,
  interactions        INTEGER NOT NULL DEFAULT 0,
  private_adds        INTEGER NOT NULL DEFAULT 0,
  wakeup_conversions  INTEGER NOT NULL DEFAULT 0,
  repurchase_count    INTEGER NOT NULL DEFAULT 0,
  referral_count      INTEGER NOT NULL DEFAULT 0,
  source              TEXT NOT NULL DEFAULT 'mock' CHECK (source IN ('mock','live','simulated')),
  meta                JSONB NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, platform, account_id, day)
);

ALTER TABLE account_growth_daily ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_account_growth_daily_ws ON account_growth_daily;
CREATE POLICY p_account_growth_daily_ws ON account_growth_daily
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

GRANT SELECT, INSERT, UPDATE ON account_growth_daily TO workloom_app;
GRANT SELECT ON account_growth_daily TO workloom_gateway;

CREATE OR REPLACE VIEW growth_daily AS
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
