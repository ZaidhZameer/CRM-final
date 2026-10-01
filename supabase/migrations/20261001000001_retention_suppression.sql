-- UK GDPR retention + suppression list.
--  * contact_suppressions: hashed opt-out emails kept indefinitely (service role only).
--  * app.anonymise_stale_leads(): anonymise unconverted leads idle for p_months.
--  * leads BEFORE INSERT trigger: a lead whose contact email is suppressed starts do_not_contact.

CREATE TABLE public.contact_suppressions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  email_sha256    text NOT NULL CHECK (email_sha256 ~ '^[0-9a-f]{64}$'),
  reason          text NOT NULL DEFAULT 'opt_out',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, email_sha256)
);

-- No policies + no grants: only the service role (which bypasses RLS) and SECURITY DEFINER code touch it.
ALTER TABLE public.contact_suppressions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.contact_suppressions FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION app.email_sha256(p_email text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE WHEN nullif(btrim(p_email), '') IS NULL THEN NULL
         ELSE encode(sha256(convert_to(lower(btrim(p_email)), 'UTF8')), 'hex') END
$$;

CREATE OR REPLACE FUNCTION app.anonymise_stale_leads(p_months int DEFAULT 12)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ids uuid[];
BEGIN
  SELECT coalesce(array_agg(l.id), '{}') INTO v_ids
  FROM public.leads l
  WHERE greatest(l.created_at, l.updated_at, coalesce(l.last_contacted_at, l.created_at))
          < now() - make_interval(months => p_months)
    AND l.status <> 'converted'
    AND NOT EXISTS (SELECT 1 FROM public.deals d WHERE d.lead_id = l.id AND d.status = 'open')
    AND NOT EXISTS (SELECT 1 FROM public.proposals p
                    WHERE p.lead_id = l.id AND p.status IN ('draft', 'approved', 'sent'));

  IF cardinality(v_ids) = 0 THEN
    RETURN 0;
  END IF;

  -- (i) opt-outs survive anonymisation as a hash only.
  INSERT INTO public.contact_suppressions (organization_id, email_sha256, reason)
  SELECT DISTINCT l.organization_id, app.email_sha256(c.email), 'do_not_contact'
  FROM public.leads l
  JOIN public.contacts c ON c.id = l.contact_id
  WHERE l.id = ANY (v_ids) AND l.do_not_contact AND app.email_sha256(c.email) IS NOT NULL
  ON CONFLICT (organization_id, email_sha256) DO NOTHING;

  -- (ii) personal data. A contact still used by a lead that is NOT being anonymised is left alone.
  UPDATE public.contacts c
  SET full_name = 'Anonymised', email = NULL, phone = NULL, job_title = NULL, linkedin_url = NULL
  WHERE c.id IN (SELECT contact_id FROM public.leads WHERE id = ANY (v_ids) AND contact_id IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM public.leads o WHERE o.contact_id = c.id AND o.id <> ALL (v_ids));

  UPDATE public.lead_form_submissions SET data_json = '{}'::jsonb
  WHERE converted_lead_id = ANY (v_ids) AND data_json <> '{}'::jsonb;

  UPDATE public.outreach_messages SET body = '[removed]', to_email = NULL
  WHERE lead_id = ANY (v_ids) AND (body <> '[removed]' OR to_email IS NOT NULL);

  DELETE FROM public.research_reports WHERE lead_id = ANY (v_ids);

  -- (iii) soft-delete + clear booking answers.
  UPDATE public.leads
  SET booking_answers_json = NULL, deleted_at = coalesce(deleted_at, now())
  WHERE id = ANY (v_ids);

  RETURN cardinality(v_ids);
END;
$$;

REVOKE ALL ON FUNCTION app.anonymise_stale_leads(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.anonymise_stale_leads(int) TO service_role;

-- PostgREST only exposes public: thin wrapper for the cron route (service role only).
CREATE OR REPLACE FUNCTION public.anonymise_stale_leads(p_months int DEFAULT 12)
RETURNS int
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ SELECT app.anonymise_stale_leads(p_months) $$;

REVOKE ALL ON FUNCTION public.anonymise_stale_leads(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anonymise_stale_leads(int) TO service_role;

-- Intake: leads whose contact email is on the org's suppression list start as do-not-contact.
-- On leads (not contacts) because do_not_contact lives there and every intake path
-- (form, booking, import) sets leads.contact_id; the contact row exists by then.
CREATE OR REPLACE FUNCTION app.apply_suppression_to_lead()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.contact_id IS NOT NULL AND NOT NEW.do_not_contact
     AND EXISTS (
       SELECT 1
       FROM public.contacts c
       JOIN public.contact_suppressions s
         ON s.organization_id = NEW.organization_id AND s.email_sha256 = app.email_sha256(c.email)
       WHERE c.id = NEW.contact_id
     ) THEN
    NEW.do_not_contact := true;
    NEW.do_not_contact_at := now();
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.apply_suppression_to_lead() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER leads_apply_suppression
  BEFORE INSERT OR UPDATE OF contact_id ON public.leads
  FOR EACH ROW EXECUTE FUNCTION app.apply_suppression_to_lead();
