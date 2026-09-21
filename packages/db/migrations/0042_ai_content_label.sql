-- 0042_ai_content_label.sql · B-28 AI 生成内容标识字段
-- 只增不改：素材表补 AI 生成标识（显式文案/生成模型/隐式标识清单），历史行默认非 AI 生成。
ALTER TABLE video_assets
  ADD COLUMN IF NOT EXISTS ai_generated BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_label TEXT,
  ADD COLUMN IF NOT EXISTS generator_model TEXT,
  ADD COLUMN IF NOT EXISTS label_manifest_uri TEXT;

CREATE INDEX IF NOT EXISTS idx_video_assets_ai
  ON video_assets (workspace_id, ai_generated) WHERE ai_generated;
