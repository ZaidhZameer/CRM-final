-- PECR: automated follow-ups may go to people who contacted us (lead form, booking page) and
-- to corporate subscribers (limited companies, LLPs). Imported/cold leads that could be sole
-- traders or partnerships need prior consent, so automation leaves them alone unless a human
-- marks the lead as a corporate subscriber. Humans can still email anyone themselves.
-- Spec: Obsidian SALES-OS/INTERNAL/FLOWLEAD_FOLLOWUPS_SPEC_2026-09-24.md (decision 4).

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS is_corporate_subscriber boolean NOT NULL DEFAULT false;

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
    IF NOT (l.source IN ('web_form', 'booking_page') OR l.is_corporate_subscriber) THEN
      RETURN 'not_eligible_pecr';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
