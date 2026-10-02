-- Lead sourcing v2 (spec: Obsidian SALES-OS/INTERNAL/FLOWLEAD_LEAD_SOURCING_SPEC_2026-10-01.md).
-- Both tables are service-role only, like mail_connections: owners/admins use server actions.

-- Per-org switches. Everything defaults OFF: nothing is found or sent until the owner turns it on.
CREATE TABLE IF NOT EXISTS public.sourcing_settings (
  organization_id        uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  enabled                boolean NOT NULL DEFAULT false,
  campaign               text NOT NULL DEFAULT 'websites' CHECK (campaign IN ('websites', 'agencies')),
  sic_codes              text[] NOT NULL DEFAULT '{}',
  location               text CHECK (location IS NULL OR length(location) <= 80),
  min_age_years          smallint NOT NULL DEFAULT 1 CHECK (min_age_years BETWEEN 0 AND 50),
  max_age_years          smallint NOT NULL DEFAULT 10 CHECK (max_age_years BETWEEN 0 AND 100),
  daily_cap              smallint NOT NULL DEFAULT 10 CHECK (daily_cap BETWEEN 1 AND 50),
  -- Automated cold first-touch emails stay blocked until the owner confirms a separate sending
  -- domain (SPF/DKIM/DMARC) exists. Used by the first-touch guard.
  cold_sending_confirmed boolean NOT NULL DEFAULT false,
  updated_by             uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (max_age_years >= min_age_years)
);

-- Every company ever found, so it is never processed twice (even if the lead is later deleted).
CREATE TABLE IF NOT EXISTS public.sourced_companies (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  company_number   text NOT NULL CHECK (length(company_number) BETWEEN 1 AND 20),
  name             text NOT NULL,
  campaign         text NOT NULL DEFAULT 'websites',
  sic_codes        text[] NOT NULL DEFAULT '{}',
  incorporated_on  date,
  address          text,
  directors        jsonb NOT NULL DEFAULT '[]'::jsonb,
  website          text,
  status           text NOT NULL DEFAULT 'found'
                   CHECK (status IN ('found', 'lead_created', 'skipped_duplicate', 'skipped_cap', 'error')),
  lead_id          uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  note             text,
  found_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, company_number)
);
CREATE INDEX IF NOT EXISTS idx_sourced_companies_org_found ON public.sourced_companies (organization_id, found_at DESC);

ALTER TABLE public.sourcing_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sourced_companies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sourcing_settings FROM anon, authenticated;
REVOKE ALL ON public.sourced_companies FROM anon, authenticated;
