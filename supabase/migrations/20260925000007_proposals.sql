-- Proposals (spec: Obsidian SALES-OS/INTERNAL/FLOWLEAD_PROPOSALS_SPEC_2026-09-25.md).
-- AI drafts the words; a human sets the price. A proposal cannot be approved, sent or accepted
-- without a positive price, enforced here so no code path can skip it.

CREATE TABLE IF NOT EXISTS public.proposals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lead_id         uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  deal_id         uuid REFERENCES public.deals(id) ON DELETE SET NULL,
  meeting_id      uuid REFERENCES public.meetings(id) ON DELETE SET NULL,
  approval_id     uuid REFERENCES public.approvals(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'approved', 'sent', 'accepted', 'declined', 'expired', 'withdrawn')),
  title           text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  brief           text CHECK (brief IS NULL OR length(brief) <= 4000),
  content_json    jsonb NOT NULL DEFAULT '{}'::jsonb,
  price_amount    numeric(12, 2) CHECK (price_amount IS NULL OR price_amount >= 0),
  currency        text NOT NULL DEFAULT 'GBP' CHECK (currency IN ('GBP', 'USD', 'EUR')),
  price_type      text NOT NULL DEFAULT 'one_off' CHECK (price_type IN ('one_off', 'monthly')),
  price_notes     text CHECK (price_notes IS NULL OR length(price_notes) <= 2000),
  valid_until     date,
  share_token     text NOT NULL UNIQUE
                  DEFAULT replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  sent_at         timestamptz,
  decided_at      timestamptz,
  decline_reason  text CHECK (decline_reason IS NULL OR length(decline_reason) <= 2000),
  version         integer NOT NULL DEFAULT 1,
  created_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  -- The human-set price is mandatory once a proposal leaves draft.
  CONSTRAINT proposals_price_required
    CHECK (status IN ('draft', 'withdrawn', 'expired', 'declined') OR (price_amount IS NOT NULL AND price_amount > 0))
);

CREATE INDEX IF NOT EXISTS idx_proposals_org_status ON public.proposals (organization_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_proposals_lead ON public.proposals (lead_id);

CREATE TRIGGER proposals_updated_at BEFORE UPDATE ON public.proposals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE public.proposals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.proposals FROM anon;

-- Staff roles only: an invited 'client' member must not see other proposals or prices.
CREATE POLICY proposals_select ON public.proposals FOR SELECT
  USING (app.has_role(organization_id, ARRAY['owner', 'admin', 'sales', 'project_manager', 'viewer']::public.membership_role[]));
CREATE POLICY proposals_insert ON public.proposals FOR INSERT
  WITH CHECK (app.has_role(organization_id, ARRAY['owner', 'admin', 'sales']::public.membership_role[]));
CREATE POLICY proposals_update ON public.proposals FOR UPDATE
  USING (app.has_role(organization_id, ARRAY['owner', 'admin', 'sales']::public.membership_role[]))
  WITH CHECK (app.has_role(organization_id, ARRAY['owner', 'admin', 'sales']::public.membership_role[]));
-- No DELETE policy: proposals are soft-deleted (deleted_at) or withdrawn.
