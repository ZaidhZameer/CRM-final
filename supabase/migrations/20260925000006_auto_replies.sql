-- Instant acknowledgement of form enquiries (speed to lead). The owner writes the template once
-- and switches it on; that one-time approval replaces per-email approval for this message only.
-- Decided by Zaid 2026-09-25. Service-role only: read/written through owner/admin server actions.
CREATE TABLE IF NOT EXISTS public.auto_replies (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  enabled         boolean NOT NULL DEFAULT false,
  subject         text NOT NULL DEFAULT 'Thanks for getting in touch, {first_name}' CHECK (length(subject) BETWEEN 1 AND 300),
  body            text NOT NULL DEFAULT E'Hi {first_name},\n\nThanks for your message. I''ve got it and will get back to you personally today.\n\nBest,\n{sender_name}' CHECK (length(body) BETWEEN 1 AND 5000),
  updated_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.auto_replies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.auto_replies FROM anon, authenticated;
