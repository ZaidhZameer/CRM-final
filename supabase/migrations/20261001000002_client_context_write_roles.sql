-- client_context feeds every AI draft (proposals, follow-ups). Any member could insert/update it,
-- including 'viewer' and invited 'client' roles, so a client could rewrite the agency's own
-- do/don't rules from the browser. Writes are now staff-only; reading stays member-wide
-- except for clients.
DROP POLICY IF EXISTS client_context_select ON public.client_context;
DROP POLICY IF EXISTS client_context_insert ON public.client_context;
DROP POLICY IF EXISTS client_context_update ON public.client_context;

CREATE POLICY client_context_select ON public.client_context FOR SELECT
  USING (app.has_role(organization_id, ARRAY['owner', 'admin', 'sales', 'project_manager', 'viewer']::public.membership_role[]));
CREATE POLICY client_context_insert ON public.client_context FOR INSERT
  WITH CHECK (app.has_role(organization_id, ARRAY['owner', 'admin', 'sales', 'project_manager']::public.membership_role[]));
CREATE POLICY client_context_update ON public.client_context FOR UPDATE
  USING (app.has_role(organization_id, ARRAY['owner', 'admin', 'sales', 'project_manager']::public.membership_role[]))
  WITH CHECK (app.has_role(organization_id, ARRAY['owner', 'admin', 'sales', 'project_manager']::public.membership_role[]));
