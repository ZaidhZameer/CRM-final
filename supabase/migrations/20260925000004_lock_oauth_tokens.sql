-- SECURITY: google_oauth_tokens had member-level RLS (SELECT/UPDATE/DELETE for any org member,
-- INSERT unchecked), so any member, including viewer/client roles, could read the org's Google
-- access and refresh tokens from the browser with the anon key. The app only ever touches this
-- table through the service role, so user roles get no access at all.
REVOKE ALL ON public.google_oauth_tokens FROM anon, authenticated;
DROP POLICY IF EXISTS google_oauth_tokens_select ON public.google_oauth_tokens;
DROP POLICY IF EXISTS google_oauth_tokens_insert ON public.google_oauth_tokens;
DROP POLICY IF EXISTS google_oauth_tokens_update ON public.google_oauth_tokens;
DROP POLICY IF EXISTS google_oauth_tokens_delete ON public.google_oauth_tokens;
-- RLS stays enabled with no policies: deny-all for every role except service_role.

-- Mailbox connections for sending follow-ups and reading replies (Gmail API).
-- Service-role only, like the tokens above; the app exposes connection status through
-- server actions, never the tokens themselves.
CREATE TABLE IF NOT EXISTS public.mail_connections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  profile_id        uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  provider          text NOT NULL DEFAULT 'gmail' CHECK (provider IN ('gmail')),
  email             text NOT NULL,
  access_token      text NOT NULL,
  refresh_token     text,
  token_expires_at  timestamptz NOT NULL,
  scopes            text[] NOT NULL DEFAULT '{}',
  status            text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'revoked', 'error')),
  last_error        text,
  last_history_id   text,          -- Gmail history cursor for reply polling
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, provider)  -- one sending mailbox per org for now
);

ALTER TABLE public.mail_connections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mail_connections FROM anon, authenticated;
