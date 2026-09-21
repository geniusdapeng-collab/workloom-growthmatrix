-- 声明式触发器标识（T-2026-0921-0003 / B-02）
--
-- 背景：triggers.id 是全局主键，而声明式触发器需要在多个工作区同时装载同一个声明
-- （例如 tg-intel-0700 在每家客户工作区都要有一份）。因此落库 id 采用
-- `<declared_id>-<workspace_id>` 的工作区后缀形态（与 agents 的 id 规则一致），
-- 并用 declared_id 列保留包内声明标识，供幂等 upsert 与审计使用。
--
-- 语义：
--   - declared_id 非空 = 由行业包声明装载；装配器按 (workspace_id, declared_id) 幂等 upsert；
--   - declared_id 为空 = 客户自建触发器；装配器不得覆盖或删除（客户治理主权）；
--   - 声明退出（新版本不再声明某 id）时不删除行，改为 enabled=false + 版本落账。

ALTER TABLE triggers
  ADD COLUMN IF NOT EXISTS declared_id TEXT;

COMMENT ON COLUMN triggers.declared_id IS '行业包声明标识；NULL 表示客户自建（装配不覆盖）';

CREATE UNIQUE INDEX IF NOT EXISTS idx_triggers_ws_declared
  ON triggers (workspace_id, declared_id)
  WHERE declared_id IS NOT NULL;
