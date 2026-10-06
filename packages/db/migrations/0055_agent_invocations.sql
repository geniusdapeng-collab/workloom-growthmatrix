-- T-2026-1004-0904: CLI/MCP calls reuse the service executor with durable, scoped ownership.
CREATE TABLE agent_invocations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  member_no TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  action TEXT NOT NULL CHECK (action IN ('task.dispatch','task.cancel','film.start')),
  input_sha256 TEXT NOT NULL CHECK (input_sha256 ~ '^[a-f0-9]{64}$'),
  request_meta JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(request_meta)='object'),
  owner_token TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','linked','resolved','failed','unknown','cancelled')),
  entity_kind TEXT CHECK (entity_kind IN ('thread','film')),
  entity_id TEXT,
  event_id TEXT,
  result JSONB,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,workspace_id,member_no,idempotency_key),
  FOREIGN KEY (workspace_id,member_no) REFERENCES members(workspace_id,member_no),
  CHECK ((entity_kind IS NULL) = (entity_id IS NULL)),
  CHECK (state <> 'linked' OR (entity_id IS NOT NULL AND event_id IS NOT NULL)),
  CHECK (state <> 'reserved' OR (entity_id IS NULL AND event_id IS NULL AND result IS NULL AND failure_code IS NULL)),
  CHECK (state <> 'resolved' OR result IS NOT NULL),
  CHECK (state NOT IN ('failed','unknown') OR failure_code IS NOT NULL)
);
CREATE INDEX idx_agent_invocations_scope ON agent_invocations (tenant_id,workspace_id,member_no,updated_at DESC);
ALTER TABLE agent_invocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_invocations FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_invocations_scope ON agent_invocations
  USING (tenant_id=current_setting('app.tenant_id',true)
    AND workspace_id=current_setting('app.workspace_id',true) AND member_no=current_setting('app.member_no',true))
  WITH CHECK (tenant_id=current_setting('app.tenant_id',true)
    AND workspace_id=current_setting('app.workspace_id',true) AND member_no=current_setting('app.member_no',true));
GRANT SELECT,INSERT,UPDATE ON agent_invocations TO workloom_app,workloom_gateway;

CREATE FUNCTION guard_agent_invocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'agent invocation history cannot be deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'reserved' OR NOT EXISTS (
      SELECT 1 FROM workspaces w WHERE w.id=NEW.workspace_id AND w.tenant_id=NEW.tenant_id
    ) THEN RAISE EXCEPTION 'agent invocation must begin reserved in its tenant workspace'; END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id,NEW.tenant_id,NEW.workspace_id,NEW.member_no,NEW.idempotency_key,NEW.action,
         NEW.input_sha256,NEW.request_meta,NEW.owner_token,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.workspace_id,OLD.member_no,OLD.idempotency_key,OLD.action,
         OLD.input_sha256,OLD.request_meta,OLD.owner_token,OLD.created_at) THEN
    RAISE EXCEPTION 'agent invocation identity and input are immutable';
  END IF;
  IF NOT ((OLD.state='reserved' AND NEW.state IN ('reserved','linked','resolved','failed','unknown','cancelled'))
    OR (OLD.state='linked' AND NEW.state IN ('linked','cancelled'))
    OR (OLD.state IN ('resolved','failed','unknown','cancelled') AND NEW.state=OLD.state)) THEN
    RAISE EXCEPTION 'agent invocation transition forbidden';
  END IF;
  IF OLD.entity_id IS NOT NULL AND ROW(NEW.entity_kind,NEW.entity_id,NEW.event_id)
     IS DISTINCT FROM ROW(OLD.entity_kind,OLD.entity_id,OLD.event_id) THEN
    RAISE EXCEPTION 'agent invocation entity cannot be rebound';
  END IF;
  IF OLD.state IN ('resolved','failed','unknown','cancelled') AND ROW(NEW.entity_kind,NEW.entity_id,NEW.event_id,NEW.result,NEW.failure_code)
     IS DISTINCT FROM ROW(OLD.entity_kind,OLD.entity_id,OLD.event_id,OLD.result,OLD.failure_code) THEN
    RAISE EXCEPTION 'agent invocation terminal receipt is immutable';
  END IF;
  IF OLD.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result THEN
    RAISE EXCEPTION 'agent invocation response snapshot is immutable';
  END IF;
  IF OLD.state='reserved' AND NEW.state='linked' THEN
    IF NOT EXISTS (SELECT 1 FROM biz_events e WHERE e.tenant_id=NEW.tenant_id AND e.workspace_id=NEW.workspace_id AND e.event_id=NEW.event_id
      AND e.payload->'who'->>'type'='human' AND e.payload->'who'->>'id'=NEW.member_no
      AND e.payload->'object'->>'id'=NEW.entity_id
      AND ((NEW.entity_kind='thread' AND e.session_id=NEW.entity_id
        AND e.payload->'object'->>'type'='thread' AND e.payload->'decision'->>'action'='thread.dispatch')
        OR (NEW.entity_kind='film' AND e.payload->'object'->>'type'='film_job' AND e.payload->'decision'->>'action'='film.start'))) THEN
      RAISE EXCEPTION 'agent invocation requires an in-scope dispatch event';
    END IF;
    IF NEW.entity_kind='thread' AND (NEW.action<>'task.dispatch' OR NOT EXISTS (
      SELECT 1 FROM threads t WHERE t.id=NEW.entity_id AND t.tenant_id=NEW.tenant_id
        AND t.workspace_id=NEW.workspace_id AND t.created_by=NEW.member_no
    )) THEN RAISE EXCEPTION 'agent thread binding mismatch'; END IF;
    IF NEW.entity_kind='film' AND (NEW.action<>'film.start' OR NOT EXISTS (
      SELECT 1 FROM film_jobs j WHERE j.id=NEW.entity_id AND j.tenant_id=NEW.tenant_id
        AND j.workspace_id=NEW.workspace_id AND j.created_by=NEW.member_no
    )) THEN RAISE EXCEPTION 'agent film binding mismatch'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_invocations_guard BEFORE INSERT OR UPDATE OR DELETE ON agent_invocations
  FOR EACH ROW EXECUTE FUNCTION guard_agent_invocation();
