BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT extensions.plan(3);

INSERT INTO auth.users (id, email) VALUES
  ('99999999-9999-9999-9999-999999999991', 'own@cc.test'),
  ('99999999-9999-9999-9999-999999999992', 'cli@cc.test');
CREATE TEMP TABLE ctx AS
SELECT (SELECT default_organization_id FROM public.profiles WHERE user_id = '99999999-9999-9999-9999-999999999991') AS org,
       (SELECT id FROM public.profiles WHERE user_id = '99999999-9999-9999-9999-999999999992') AS client_profile;
GRANT SELECT ON ctx TO authenticated;
INSERT INTO public.memberships (organization_id, profile_id, role, status)
SELECT org, client_profile, 'client'::public.membership_role, 'active'::public.membership_status FROM ctx;
INSERT INTO public.client_context (organization_id, services) SELECT org, 'Websites' FROM ctx;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"99999999-9999-9999-9999-999999999992","role":"authenticated"}', true);
UPDATE public.client_context SET dont_rules = 'hijacked';
SELECT is((SELECT count(*)::int FROM public.client_context), 0, 'an invited client cannot see the agency profile');
SELECT throws_ok($$ INSERT INTO public.client_context (organization_id, services) SELECT org, 'x' FROM ctx $$, '42501', NULL, 'an invited client cannot create one');

SELECT set_config('request.jwt.claims', '{"sub":"99999999-9999-9999-9999-999999999991","role":"authenticated"}', true);
SELECT is((SELECT dont_rules FROM public.client_context LIMIT 1), NULL, 'the client''s update did not land');

SELECT * FROM finish();
ROLLBACK;
