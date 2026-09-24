-- Phase 1 core loop: jobs, approvals, client context, database-enforced interlocks,
-- and closing the api_rate_limits exposure. See Obsidian FLOWLEAD_MASTER_PLAN_2026-09-24.

-- =============================================================================
-- 0. api_rate_limits: RLS was off and anon/authenticated held full privileges,
--    so anyone with the public anon key could read, insert, delete or truncate it.
--    The app rate-limits through Redis; this table is only used by
--    check_rate_limit(), which now runs as its owner.
-- =============================================================================
ALTER TABLE public.api_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.api_rate_limits FROM anon, authenticated;

ALTER FUNCTION public.check_rate_limit(text, text, integer, integer)
  SECURITY DEFINER SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.check_rate_limit(text, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(text, text, integer, integer) TO authenticated, service_role;

-- =============================================================================
-- 1. Role helper (same shape as app.is_member)
-- =============================================================================
CREATE OR REPLACE FUNCTION app.has_role(org_id uuid, roles public.membership_role[])
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships m
    JOIN public.profiles p ON p.id = m.profile_id
    WHERE m.organization_id = org_id
      AND p.user_id = auth.uid()
      AND m.status = 'active'
      AND m.role = ANY (roles)
  )
$$;

-- =============================================================================
-- 2. Interlocks, enforced in the database so every write path obeys them.
--    source = 'automation' marks rows created by the engine; 'user' by a person.
--    - do_not_contact: blocks all new pending follow-ups and all sent outreach,
--      and skips every pending follow-up the moment it is set.
--    - closed lead (converted/lost, pipeline won/lost, or deleted): blocks
--      automation follow-ups/outreach and skips pending automation follow-ups.
--    - meeting scheduled in the future: pauses automation follow-ups/outreach.
--    - at most one pending follow-up per lead.
-- =============================================================================
ALTER TABLE public.leads
  ADD COLUMN do_not_contact boolean NOT NULL DEFAULT false,
  ADD COLUMN do_not_contact_at timestamptz;

ALTER TABLE public.follow_ups
  ADD COLUMN source text NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'automation'));

ALTER TABLE public.outreach_messages
  ADD COLUMN source text NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'automation'));

CREATE OR REPLACE FUNCTION app.lead_is_closed(l public.leads)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT l.deleted_at IS NOT NULL
      OR l.status IN ('converted', 'lost')
      OR l.pipeline_stage IN ('won', 'lost')
$$;

-- Returns why contact is blocked for this lead and source, or NULL if allowed.
CREATE OR REPLACE FUNCTION app.contact_block_reason(p_lead_id uuid, p_source text)
RETURNS text
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  l public.leads;
BEGIN
  SELECT * INTO l FROM public.leads WHERE id = p_lead_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF l.do_not_contact THEN
    RETURN 'do_not_contact';
  END IF;
  IF p_source = 'automation' THEN
    IF app.lead_is_closed(l) THEN
      RETURN 'lead_closed';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.meetings m
      WHERE m.lead_id = l.id AND m.status = 'scheduled' AND m.start_time > now()
    ) THEN
      RETURN 'meeting_scheduled';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION app.enforce_follow_up_interlocks()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  reason text;
BEGIN
  IF NEW.status <> 'pending' OR NEW.lead_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'pending' AND OLD.lead_id = NEW.lead_id THEN
    RETURN NEW; -- editing an already-pending follow-up (e.g. rescheduling)
  END IF;

  reason := app.contact_block_reason(NEW.lead_id, NEW.source);
  IF reason IS NOT NULL THEN
    RAISE EXCEPTION 'follow_up_blocked: %', reason USING ERRCODE = 'P0001';
  END IF;

  -- Serialise per lead so two concurrent inserts cannot both pass the check.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.lead_id::text, 0));
  IF EXISTS (
    SELECT 1 FROM public.follow_ups f
    WHERE f.lead_id = NEW.lead_id AND f.status = 'pending' AND f.id <> NEW.id
  ) THEN
    RAISE EXCEPTION 'follow_up_blocked: pending_exists' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER follow_ups_interlocks
  BEFORE INSERT OR UPDATE OF status, lead_id, source ON public.follow_ups
  FOR EACH ROW EXECUTE FUNCTION app.enforce_follow_up_interlocks();

CREATE OR REPLACE FUNCTION app.enforce_outreach_interlocks()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  reason text;
BEGIN
  -- Humans may draft freely; sending is always checked. Automation is checked for drafts too.
  IF NEW.status = 'sent' OR NEW.source = 'automation' THEN
    IF TG_OP = 'UPDATE' AND OLD.status = NEW.status AND OLD.lead_id = NEW.lead_id THEN
      RETURN NEW;
    END IF;
    reason := app.contact_block_reason(NEW.lead_id, NEW.source);
    IF reason IS NOT NULL THEN
      RAISE EXCEPTION 'outreach_blocked: %', reason USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER outreach_messages_interlocks
  BEFORE INSERT OR UPDATE OF status, lead_id, source ON public.outreach_messages
  FOR EACH ROW EXECUTE FUNCTION app.enforce_outreach_interlocks();

CREATE OR REPLACE FUNCTION app.stamp_do_not_contact()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.do_not_contact AND NOT OLD.do_not_contact THEN
    NEW.do_not_contact_at := now();
  ELSIF NOT NEW.do_not_contact THEN
    NEW.do_not_contact_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER leads_stamp_do_not_contact
  BEFORE UPDATE OF do_not_contact ON public.leads
  FOR EACH ROW EXECUTE FUNCTION app.stamp_do_not_contact();

-- Kill switch: stop queued work the moment a lead closes or opts out.
CREATE OR REPLACE FUNCTION app.lead_kill_switch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.do_not_contact AND NOT OLD.do_not_contact THEN
    UPDATE public.follow_ups SET status = 'skipped'
    WHERE lead_id = NEW.id AND status = 'pending';
  ELSIF app.lead_is_closed(NEW) AND NOT app.lead_is_closed(OLD) THEN
    UPDATE public.follow_ups SET status = 'skipped'
    WHERE lead_id = NEW.id AND status = 'pending' AND source = 'automation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER leads_kill_switch
  AFTER UPDATE OF status, pipeline_stage, do_not_contact, deleted_at ON public.leads
  FOR EACH ROW EXECUTE FUNCTION app.lead_kill_switch();

-- Meeting pause: a newly scheduled future meeting skips pending automation follow-ups.
CREATE OR REPLACE FUNCTION app.meeting_pause()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.lead_id IS NOT NULL AND NEW.status = 'scheduled' AND NEW.start_time > now()
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status OR OLD.start_time IS DISTINCT FROM NEW.start_time) THEN
    UPDATE public.follow_ups SET status = 'skipped'
    WHERE lead_id = NEW.lead_id AND status = 'pending' AND source = 'automation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER meetings_pause_follow_ups
  AFTER INSERT OR UPDATE OF status, start_time, lead_id ON public.meetings
  FOR EACH ROW EXECUTE FUNCTION app.meeting_pause();

CREATE INDEX IF NOT EXISTS idx_follow_ups_lead_pending
  ON public.follow_ups (lead_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_meetings_lead_scheduled
  ON public.meetings (lead_id, start_time) WHERE status = 'scheduled';

-- =============================================================================
-- 3. jobs: every engine run is visible. Written only by the server (service role).
-- =============================================================================
CREATE TYPE public.job_status AS ENUM
  ('queued', 'running', 'awaiting_approval', 'done', 'failed', 'cancelled');

CREATE TABLE public.jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  job_type text NOT NULL,
  subject_type text,
  subject_id uuid,
  event_id uuid UNIQUE,
  status public.job_status NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  error_message text,
  result_json jsonb,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_jobs_org_status_created ON public.jobs (organization_id, status, created_at DESC);
CREATE INDEX idx_jobs_subject ON public.jobs (organization_id, subject_type, subject_id);
CREATE INDEX idx_jobs_created_by ON public.jobs (created_by);

CREATE TRIGGER jobs_updated_at BEFORE UPDATE ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY jobs_select ON public.jobs FOR SELECT USING (app.is_member(organization_id));
REVOKE ALL ON public.jobs FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.jobs FROM authenticated;

-- =============================================================================
-- 4. approvals: one inbox for every AI action that leaves the building.
--    'auto'-tier work never lands here; it runs and is logged in jobs.
--    People decide through public.decide_approval() only — no direct UPDATE.
-- =============================================================================
CREATE TYPE public.approval_tier AS ENUM ('review', 'always_human');
CREATE TYPE public.approval_status AS ENUM
  ('pending', 'approved', 'rejected', 'executed', 'expired', 'cancelled');

CREATE TABLE public.approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  action_type text NOT NULL,
  tier public.approval_tier NOT NULL,
  status public.approval_status NOT NULL DEFAULT 'pending',
  subject_type text,
  subject_id uuid,
  title text NOT NULL,
  summary text,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  edited_payload_json jsonb,
  decided_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  decided_at timestamptz,
  decision_note text,
  executed_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);

CREATE INDEX idx_approvals_org_status_created ON public.approvals (organization_id, status, created_at DESC);
CREATE INDEX idx_approvals_job ON public.approvals (job_id);
CREATE INDEX idx_approvals_decided_by ON public.approvals (decided_by);

CREATE TRIGGER approvals_updated_at BEFORE UPDATE ON public.approvals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE public.approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY approvals_select ON public.approvals FOR SELECT USING (app.is_member(organization_id));
REVOKE ALL ON public.approvals FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.approvals FROM authenticated;

CREATE OR REPLACE FUNCTION public.decide_approval(
  p_approval_id uuid,
  p_decision text,
  p_expected_version integer,
  p_note text DEFAULT NULL,
  p_edited_payload jsonb DEFAULT NULL
)
RETURNS public.approvals
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  a public.approvals;
  v_profile uuid;
BEGIN
  IF p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'invalid_decision' USING ERRCODE = 'P0001';
  END IF;
  IF p_edited_payload IS NOT NULL AND p_decision <> 'approved' THEN
    RAISE EXCEPTION 'edits_require_approval' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO a FROM public.approvals WHERE id = p_approval_id FOR UPDATE;
  -- Same answer for "doesn't exist" and "not your organisation": don't leak existence.
  IF NOT FOUND OR NOT app.is_member(a.organization_id) THEN
    RAISE EXCEPTION 'approval_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF NOT app.has_role(a.organization_id, ARRAY['owner', 'admin', 'sales', 'project_manager']::public.membership_role[]) THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = 'P0001';
  END IF;
  IF a.status <> 'pending' THEN
    RAISE EXCEPTION 'approval_not_pending' USING ERRCODE = 'P0001';
  END IF;
  IF a.expires_at IS NOT NULL AND a.expires_at <= now() THEN
    RAISE EXCEPTION 'approval_expired' USING ERRCODE = 'P0001';
  END IF;
  IF a.version <> p_expected_version THEN
    RAISE EXCEPTION 'version_conflict' USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_profile FROM public.profiles WHERE user_id = auth.uid();

  UPDATE public.approvals SET
    status = p_decision::public.approval_status,
    decided_by = v_profile,
    decided_at = now(),
    decision_note = p_note,
    edited_payload_json = COALESCE(p_edited_payload, edited_payload_json),
    version = version + 1
  WHERE id = a.id
  RETURNING * INTO a;

  IF a.job_id IS NOT NULL THEN
    UPDATE public.jobs
    SET status = CASE WHEN p_decision = 'approved' THEN 'queued'::public.job_status
                      ELSE 'cancelled'::public.job_status END
    WHERE id = a.job_id AND status = 'awaiting_approval';
  END IF;

  RETURN a;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.decide_approval(uuid, text, integer, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_approval(uuid, text, integer, text, jsonb) TO authenticated;

-- =============================================================================
-- 5. client_context: what every AI output reads about a client.
--    company_id NULL = the organisation's own business.
-- =============================================================================
CREATE TABLE public.client_context (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  company_id uuid REFERENCES public.companies(id) ON DELETE CASCADE,
  services text,
  brand_voice text,
  audience text,
  competitors text,
  past_work text,
  do_rules text,
  dont_rules text,
  extra_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX uq_client_context_org_company
  ON public.client_context (organization_id, company_id) NULLS NOT DISTINCT
  WHERE deleted_at IS NULL;
CREATE INDEX idx_client_context_company ON public.client_context (company_id);
CREATE INDEX idx_client_context_updated_by ON public.client_context (updated_by);

CREATE TRIGGER client_context_updated_at BEFORE UPDATE ON public.client_context
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE public.client_context ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_context_select ON public.client_context FOR SELECT
  USING (app.is_member(organization_id));
CREATE POLICY client_context_insert ON public.client_context FOR INSERT
  WITH CHECK (app.is_member(organization_id));
CREATE POLICY client_context_update ON public.client_context FOR UPDATE
  USING (app.is_member(organization_id)) WITH CHECK (app.is_member(organization_id));
CREATE POLICY client_context_delete ON public.client_context FOR DELETE
  USING (app.has_role(organization_id, ARRAY['owner', 'admin']::public.membership_role[]));
REVOKE ALL ON public.client_context FROM anon;
