-- 0046_onboarding_progress_state.sql · B-63 首日上岗进度服务端化（跨端断点续播）
-- 首次欢迎只用 status/current_step 两个标量；首日上岗需要四关进度、已点亮卡片、
-- 跳过记录、成就、首单线程号——统一放 state JSONB（行=投影，biz_events 里的 questline.* 仍是账本）。
ALTER TABLE onboarding_progress
  ADD COLUMN IF NOT EXISTS state JSONB NOT NULL DEFAULT '{}';

-- 按旅程检索（首日上岗漏斗/断点续播读路径）
CREATE INDEX IF NOT EXISTS idx_onboarding_progress_journey
  ON onboarding_progress (workspace_id, journey_key, status, updated_at DESC);
