-- 0045_task_contracts.sql · B-37 任务契约持久化（契约↔线程↔审批↔结算）
-- 契约是跨岗交付的唯一凭据：状态机由事件归约校验；新增 thread_id/bundle_scope/matrix_refs 用于串联。
CREATE TABLE IF NOT EXISTS task_contracts (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
  title             TEXT NOT NULL,
  goal              TEXT NOT NULL,
  requester         TEXT NOT NULL,
  assignee_preset   TEXT NOT NULL,
  verifier_preset   TEXT NOT NULL,
  success_criteria  JSONB NOT NULL DEFAULT '[]',
  budget_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
  currency          TEXT NOT NULL DEFAULT 'CNY',
  deadline          TIMESTAMPTZ,
  mode              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'draft',
  thread_id         TEXT,
  bundle_scope      JSONB NOT NULL DEFAULT '[]',
  matrix_refs       JSONB NOT NULL DEFAULT '[]',
  created_by        TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_contracts_ws_status ON task_contracts (workspace_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_contracts_thread ON task_contracts (workspace_id, thread_id);

ALTER TABLE task_contracts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_task_contracts_ws ON task_contracts;
CREATE POLICY p_task_contracts_ws ON task_contracts
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- 契约只增不改状态由状态机推进：app 角色可读写状态但不可删除
GRANT SELECT, INSERT, UPDATE ON task_contracts TO workloom_app;
GRANT SELECT ON task_contracts TO workloom_gateway;
REVOKE DELETE ON task_contracts FROM workloom_app;
