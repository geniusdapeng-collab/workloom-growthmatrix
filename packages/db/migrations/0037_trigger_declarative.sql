-- 触发器声明式装载（T-2026-0921-0003 / B-04）
--
-- 背景：触发器此前硬编码在各仓 seed 脚本（tg-geo-* / tg-*），三包节拍无法合并，
-- 主工作区只落单包触发器。本迁移为声明式装载补齐来源与版本两列：
--   source_bundle   触发器来自哪个行业包（null = 客户自建，不受装配覆盖）
--   declared_version 声明式装载版本号（bundle 版本/摘要前缀），用于判断是否需要覆盖
--
-- 语义：
--   - 声明式触发器由装配器幂等 upsert；source_bundle 非空的同名 id 允许被同类声明更新；
--   - 客户自建（source_bundle IS NULL）触发器不被装配覆盖，保持客户治理主权；
--   - 不删除任何历史触发器行（只增不改；下线通过 enabled=false + 事件留痕）。

ALTER TABLE triggers
  ADD COLUMN IF NOT EXISTS source_bundle TEXT,
  ADD COLUMN IF NOT EXISTS declared_version TEXT;

COMMENT ON COLUMN triggers.source_bundle IS '声明来源行业包；NULL 表示客户自建（装配不覆盖）';
COMMENT ON COLUMN triggers.declared_version IS '声明式装载版本（bundle 版本或摘要前缀）';

CREATE INDEX IF NOT EXISTS idx_triggers_ws_source
  ON triggers (workspace_id, source_bundle);
