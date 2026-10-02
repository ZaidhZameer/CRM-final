-- Agent registry settings (decision: Obsidian wiki/decisions/2026-10-02-flowlead-agent-registry.md).
-- Service-role only; owners/admins use server actions. Missing row = everything off (L0).
CREATE TABLE IF NOT EXISTS public.agent_settings (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  agent           text NOT NULL CHECK (agent ~ '^[a-z_]{2,40}$'),
  autonomy_level  smallint NOT NULL DEFAULT 0 CHECK (autonomy_level BETWEEN 0 AND 3),
  updated_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, agent)
);

-- One switch that stops every agent for the organization.
CREATE TABLE IF NOT EXISTS public.agent_controls (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  agents_paused   boolean NOT NULL DEFAULT false,
  paused_by       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  paused_at       timestamptz
);

ALTER TABLE public.agent_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_controls ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.agent_settings FROM anon, authenticated;
REVOKE ALL ON public.agent_controls FROM anon, authenticated;
