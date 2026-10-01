-- Quarterly reactivation of old leads that went quiet: ONE friendly, approval-gated check-in.
-- Reuses the follow-up machinery (draft -> Approval Inbox -> human approves -> sent at the slot).
--
--  * follow_ups.kind: 'follow_up' (the 3-step cadence) or 'reactivation' (a single touch; the
--    sender never schedules a step 2 after it).
--  * app.reactivation_candidates(): which leads qualify. Read-only.
--  * app.schedule_reactivations(): creates the follow_ups rows (source 'automation', kind
--    'reactivation'). Every row goes through the existing follow_ups interlock trigger, so
--    do-not-contact, closed (converted/lost/won/lost stage/deleted), meeting-scheduled, PECR
--    and pending-exists are enforced exactly as for normal follow-ups. The interlock is NOT
--    changed: lost and converted leads are never reactivated.

ALTER TABLE public.follow_ups
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'follow_up';

ALTER TABLE public.follow_ups
  ADD CONSTRAINT follow_ups_kind_check CHECK (kind IN ('follow_up', 'reactivation'));

CREATE INDEX IF NOT EXISTS idx_follow_ups_reactivation
  ON public.follow_ups (lead_id, created_at) WHERE kind = 'reactivation';

-- Leads eligible for a reactivation check-in, oldest-quiet first, at most p_per_org per org.
--   status: contacted / qualified / unqualified / nurture ('new' never engaged; converted and
--     lost are closed and stay closed).
--   quiet: no lead edit, contact, outreach message, logged activity, meeting or non-skipped
--     follow-up within p_idle_days, and no reactivation (any outcome) within p_idle_days.
--   not in play: no open deal, no draft/approved/sent proposal.
--   contactable: has an email that is not suppressed, and app.contact_block_reason(...,
--     'automation') is NULL (do-not-contact, closed, meeting scheduled, PECR). The limit applies
--     AFTER these filters so ineligible leads never use up an org's quota.
CREATE OR REPLACE FUNCTION app.reactivation_candidates(p_idle_days int DEFAULT 90, p_per_org int DEFAULT 25)
RETURNS TABLE (organization_id uuid, lead_id uuid, last_activity_at timestamptz)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH quiet AS (
    SELECT l.id, l.organization_id,
      greatest(
        l.created_at, l.updated_at, coalesce(l.last_contacted_at, l.created_at),
        coalesce((SELECT max(greatest(m.created_at, m.sent_at, m.replied_at))
                  FROM public.outreach_messages m WHERE m.lead_id = l.id), l.created_at),
        coalesce((SELECT max(a.created_at) FROM public.activity_logs a
                  WHERE a.entity_type = 'lead' AND a.entity_id = l.id), l.created_at),
        coalesce((SELECT max(mt.start_time) FROM public.meetings mt WHERE mt.lead_id = l.id), l.created_at),
        coalesce((SELECT max(f.updated_at) FROM public.follow_ups f
                  WHERE f.lead_id = l.id AND f.status <> 'skipped'), l.created_at)
      ) AS last_activity_at
    FROM public.leads l
    JOIN public.contacts c ON c.id = l.contact_id
    WHERE l.deleted_at IS NULL
      AND NOT l.do_not_contact
      AND l.status IN ('contacted', 'qualified', 'unqualified', 'nurture')
      AND NOT app.lead_is_closed(l)
      AND nullif(btrim(c.email), '') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.contact_suppressions s
        WHERE s.organization_id = l.organization_id AND s.email_sha256 = app.email_sha256(c.email))
      AND NOT EXISTS (SELECT 1 FROM public.deals d WHERE d.lead_id = l.id AND d.status = 'open')
      AND NOT EXISTS (SELECT 1 FROM public.proposals p
                      WHERE p.lead_id = l.id AND p.status IN ('draft', 'approved', 'sent'))
      AND NOT EXISTS (SELECT 1 FROM public.follow_ups f
                      WHERE f.lead_id = l.id AND f.kind = 'reactivation'
                        AND f.created_at > now() - make_interval(days => p_idle_days))
      AND NOT EXISTS (SELECT 1 FROM public.follow_ups f WHERE f.lead_id = l.id AND f.status = 'pending')
      AND app.contact_block_reason(l.id, 'automation') IS NULL
  ),
  ranked AS (
    SELECT q.*, row_number() OVER (PARTITION BY q.organization_id ORDER BY q.last_activity_at ASC, q.id) AS rn
    FROM quiet q
    WHERE q.last_activity_at < now() - make_interval(days => p_idle_days)
  )
  SELECT r.organization_id, r.id, r.last_activity_at
  FROM ranked r
  WHERE r.rn <= p_per_org
  ORDER BY r.organization_id, r.rn
$$;

-- Creates one pending reactivation follow-up per candidate. A row the interlock refuses (a race
-- since the candidate query) is skipped, not fatal.
CREATE OR REPLACE FUNCTION app.schedule_reactivations(
  p_scheduled_for timestamptz,
  p_idle_days int DEFAULT 90,
  p_per_org int DEFAULT 25
)
RETURNS TABLE (scheduled int, skipped int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r record;
  v_scheduled int := 0;
  v_skipped int := 0;
BEGIN
  FOR r IN SELECT * FROM app.reactivation_candidates(p_idle_days, p_per_org) LOOP
    BEGIN
      INSERT INTO public.follow_ups
        (organization_id, lead_id, scheduled_for, reason, status, source, step, decided_by, kind)
      VALUES
        (r.organization_id, r.lead_id, p_scheduled_for, 'Reactivation: quarterly check-in',
         'pending', 'automation', 1, 'rule', 'reactivation');
      v_scheduled := v_scheduled + 1;
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      v_skipped := v_skipped + 1;
    END;
  END LOOP;
  RETURN QUERY SELECT v_scheduled, v_skipped;
END;
$$;

REVOKE ALL ON FUNCTION app.reactivation_candidates(int, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.schedule_reactivations(timestamptz, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.reactivation_candidates(int, int) TO service_role;
GRANT EXECUTE ON FUNCTION app.schedule_reactivations(timestamptz, int, int) TO service_role;

-- PostgREST only exposes public: thin wrapper for the cron route (service role only).
CREATE OR REPLACE FUNCTION public.schedule_reactivations(
  p_scheduled_for timestamptz,
  p_idle_days int DEFAULT 90,
  p_per_org int DEFAULT 25
)
RETURNS TABLE (scheduled int, skipped int)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ SELECT * FROM app.schedule_reactivations(p_scheduled_for, p_idle_days, p_per_org) $$;

REVOKE ALL ON FUNCTION public.schedule_reactivations(timestamptz, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.schedule_reactivations(timestamptz, int, int) TO service_role;
