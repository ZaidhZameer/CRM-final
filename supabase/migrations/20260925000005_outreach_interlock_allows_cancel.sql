-- The outreach interlock re-checked do-not-contact / closed / PECR on every status change of an
-- automation message, including marking it 'failed'. Once a lead opted out, the sender could
-- not record that the queued email was cancelled, so it stayed 'queued' forever (it was never
-- sent, but it could never be closed either). Only moves TOWARDS the recipient are checked now:
-- any send, and automation drafts/queued messages. Cancelling or failing is always allowed.

CREATE OR REPLACE FUNCTION app.enforce_outreach_interlocks()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  reason text;
BEGIN
  IF NEW.status = 'sent' OR (NEW.source = 'automation' AND NEW.status IN ('draft', 'queued')) THEN
    IF TG_OP = 'UPDATE' AND OLD.status = NEW.status AND OLD.lead_id = NEW.lead_id THEN
      RETURN NEW; -- editing text of an already-checked message
    END IF;
    reason := app.contact_block_reason(NEW.lead_id, NEW.source);
    IF reason IS NOT NULL THEN
      RAISE EXCEPTION 'outreach_blocked: %', reason USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
