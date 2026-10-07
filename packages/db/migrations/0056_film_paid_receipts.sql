-- T-2026-1007-0918: bind paid film requests and preserve provider ACKs.
-- Application reserves complete provider identity before POST and reuses it across jobs.
-- The database rejects identity/ACK replacement, including after an unknown outcome.
-- Dependencies: 0046_registered_film_workers.sql. No existing receipt is rewritten.
-- Rollback preserves paid receipts; an old unprotected generation path must stay paused.
CREATE INDEX IF NOT EXISTS idx_film_paid_intent
  ON film_component_requests (tenant_id,workspace_id,project_id,component,step_key,shot_id)
  WHERE component IN ('image','video') AND dispatch_count>0;

CREATE OR REPLACE FUNCTION guard_film_component_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'reserved' OR NEW.owner_token IS NOT NULL THEN
      RAISE EXCEPTION 'film component request must begin reserved without an owner';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM film_jobs j WHERE j.id = NEW.job_id AND j.tenant_id = NEW.tenant_id
        AND j.workspace_id = NEW.workspace_id AND j.project_id = NEW.project_id AND j.status = 'running'
    ) THEN
      RAISE EXCEPTION 'film component request requires a running job in scope';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.tenant_id, NEW.workspace_id, NEW.project_id, NEW.job_id, NEW.component, NEW.step_key,
         NEW.shot_id, NEW.idempotency_key, NEW.request_hash, NEW.payload_hash, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.workspace_id, OLD.project_id, OLD.job_id, OLD.component, OLD.step_key,
         OLD.shot_id, OLD.idempotency_key, OLD.request_hash, OLD.payload_hash, OLD.created_at) THEN
    RAISE EXCEPTION 'film component request identity is immutable';
  END IF;
  -- Paid identity and ACK survive retries, failure receipts and late responses.
  IF OLD.evidence ? 'paidRequest' THEN
    IF NEW.dispatch_count IS DISTINCT FROM OLD.dispatch_count THEN
      RAISE EXCEPTION 'paid dispatch count is immutable';
    END IF;
    IF NEW.evidence->'paidRequest' IS DISTINCT FROM OLD.evidence->'paidRequest'
      OR NEW.evidence->'paidSourceComponentId' IS DISTINCT FROM OLD.evidence->'paidSourceComponentId'
      OR (OLD.evidence ? 'providerTaskId' AND NEW.evidence->'providerTaskId' IS DISTINCT FROM OLD.evidence->'providerTaskId')
      OR (OLD.evidence ? 'paidAcceptedAt' AND NEW.evidence->'paidAcceptedAt' IS DISTINCT FROM OLD.evidence->'paidAcceptedAt')
      OR (OLD.evidence ? 'paidDispatchStartedAt' AND NEW.evidence->'paidDispatchStartedAt' IS DISTINCT FROM OLD.evidence->'paidDispatchStartedAt') THEN
      RAISE EXCEPTION 'paid request and accepted task receipt are immutable';
    END IF;
  END IF;
  IF NEW.evidence ? 'paidRequest' THEN
    IF (NEW.component IN ('image','video')
      AND jsonb_typeof(NEW.evidence->'paidRequest')='object'
      AND NEW.evidence->'paidRequest'->>'schemaVersion'='workloom.film-paid-request/v1'
      AND NEW.evidence->'paidRequest'->>'provider'=NEW.provider
      AND NEW.evidence->'paidRequest'->>'providerModel'=NEW.provider_model
      AND NEW.evidence->'paidRequest'->>'method'='POST'
      AND NEW.evidence->'paidRequest'->>'payloadHash' ~ '^[a-f0-9]{64}$'
      AND NEW.dispatch_count IN (0,1)
      AND length(NEW.evidence->>'paidSourceComponentId') > 0) IS NOT TRUE THEN
      RAISE EXCEPTION 'paid request identity invalid';
    END IF;
    IF NEW.dispatch_count=1 THEN
      IF NEW.evidence->>'paidSourceComponentId' <> NEW.id THEN
        RAISE EXCEPTION 'paid original request must identify itself';
      END IF;
    ELSIF (NEW.evidence->>'paidRecovery'='true' AND NEW.reserved_cny=0 AND EXISTS (
      SELECT 1 FROM film_component_requests source
      WHERE source.id=NEW.evidence->>'paidSourceComponentId'
        AND source.tenant_id=NEW.tenant_id AND source.workspace_id=NEW.workspace_id
        AND source.project_id=NEW.project_id AND source.component=NEW.component
        AND source.step_key=NEW.step_key AND source.shot_id IS NOT DISTINCT FROM NEW.shot_id
        AND source.dispatch_count=1 AND source.evidence->'paidRequest'=NEW.evidence->'paidRequest'
        AND source.evidence ? 'providerTaskId' AND source.evidence->>'providerTaskId'=NEW.evidence->>'providerTaskId'
    )) IS NOT TRUE THEN
      RAISE EXCEPTION 'paid recovery must reference the actual original ACK in scope';
    END IF;
  END IF;
  IF OLD.owner_token IS NOT NULL AND NEW.owner_token IS DISTINCT FROM OLD.owner_token THEN
    RAISE EXCEPTION 'film component request owner is immutable';
  END IF;
  IF NOT ((OLD.state = 'reserved' AND NEW.state IN ('dispatched','failed'))
    OR (OLD.state = 'dispatched' AND NEW.state IN ('dispatched','accepted','failed','unknown'))
    OR (OLD.state IN ('accepted','failed','unknown') AND NEW.state = OLD.state)) THEN
    RAISE EXCEPTION 'film component request transition forbidden';
  END IF;
  IF OLD.state IN ('accepted','failed') AND
     ROW(NEW.state, NEW.provider, NEW.provider_model, NEW.reserved_cny, NEW.actual_cny,
         NEW.evidence - 'reconciledAt', NEW.dispatch_count)
     IS DISTINCT FROM
     ROW(OLD.state, OLD.provider, OLD.provider_model, OLD.reserved_cny, OLD.actual_cny,
         OLD.evidence - 'reconciledAt', OLD.dispatch_count) THEN
    RAISE EXCEPTION 'film component terminal receipt is immutable';
  END IF;
  RETURN NEW;
END $$;
