-- Personal access tokens for the FlowLead MCP endpoint (/api/mcp).
-- Spec: Obsidian SALES-OS/INTERNAL/FLOWLEAD_MCP_SPEC_2026-10-01.md
--
-- Only a sha256 of the token is stored; the token itself is shown once at creation. Service-role
-- only (like mail_connections): the app exposes token metadata through server actions that
-- check owner/admin or self, never to the browser with the anon key.
CREATE TABLE IF NOT EXISTS public.api_tokens (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  profile_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  token_sha256     text NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  scopes           text[] NOT NULL DEFAULT ARRAY['read']
                   CHECK (cardinality(scopes) >= 1 AND scopes <@ ARRAY['read', 'propose']::text[]),
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_used_at     timestamptz,
  expires_at       timestamptz,
  revoked_at       timestamptz
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_org ON public.api_tokens (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_tokens_profile ON public.api_tokens (profile_id);

ALTER TABLE public.api_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.api_tokens FROM anon, authenticated;
-- RLS on with no policies: deny-all for every role except service_role.

-- Every MCP tool call is recorded in activity_logs.
ALTER TYPE public.activity_action ADD VALUE IF NOT EXISTS 'mcp_call';
