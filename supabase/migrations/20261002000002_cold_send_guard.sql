-- Cold-send guard (overnight plan N4; Zaid's rule: nothing cold sends before a separate sending
-- domain exists). Leads that came from sourcing or an import are COLD: the person never contacted
-- us. Automation (follow-ups, drafts, sends, reactivation) is refused for them until the org owner
-- confirms a separate sending domain (SPF/DKIM/DMARC) in Settings. Enquirers are unaffected, and
-- humans can still email anyone themselves. Enforced here because every automated path goes
-- through app.contact_block_reason.

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
    IF (l.source LIKE 'companies\_house%' OR l.source LIKE 'import\_%')
       AND NOT COALESCE((SELECT s.cold_sending_confirmed FROM public.sourcing_settings s WHERE s.organization_id = l.organization_id), false) THEN
      RETURN 'cold_sending_not_confirmed';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
