BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT extensions.plan(7);

-- Owner of org A, plus a 'client' and a 'viewer' member of org A.
INSERT INTO auth.users (id, email) VALUES
  ('88888888-8888-8888-8888-888888888881', 'owner@p.test'),
  ('88888888-8888-8888-8888-888888888882', 'client@p.test'),
  ('88888888-8888-8888-8888-888888888883', 'viewer@p.test');
CREATE TEMP TABLE ctx AS
SELECT (SELECT default_organization_id FROM public.profiles WHERE user_id = '88888888-8888-8888-8888-888888888881') AS org,
       (SELECT id FROM public.profiles WHERE user_id = '88888888-8888-8888-8888-888888888882') AS client_profile,
       (SELECT id FROM public.profiles WHERE user_id = '88888888-8888-8888-8888-888888888883') AS viewer_profile;
GRANT SELECT ON ctx TO authenticated;
INSERT INTO public.memberships (organization_id, profile_id, role, status)
SELECT org, client_profile, 'client'::public.membership_role, 'active'::public.membership_status FROM ctx UNION ALL
SELECT org, viewer_profile, 'viewer'::public.membership_role, 'active'::public.membership_status FROM ctx;
INSERT INTO public.leads (organization_id, source) SELECT org, 'web_form' FROM ctx;
INSERT INTO public.proposals (organization_id, lead_id, title)
SELECT l.organization_id, l.id, 'Website rebuild' FROM public.leads l JOIN ctx c ON c.org = l.organization_id;

SELECT throws_ok($$ UPDATE public.proposals SET status = 'approved' WHERE title = 'Website rebuild' $$,
  '23514', NULL, 'a proposal cannot be approved without a price');
SELECT throws_ok($$ UPDATE public.proposals SET status = 'sent', price_amount = 0 WHERE title = 'Website rebuild' $$,
  '23514', NULL, 'a zero price does not count');
SELECT lives_ok($$ UPDATE public.proposals SET status = 'approved', price_amount = 2400 WHERE title = 'Website rebuild' $$,
  'with a human-set price it can be approved');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"88888888-8888-8888-8888-888888888882","role":"authenticated"}', true);
SELECT is((SELECT count(*)::int FROM public.proposals), 0, 'a client member cannot see proposals or prices');

SELECT set_config('request.jwt.claims', '{"sub":"88888888-8888-8888-8888-888888888883","role":"authenticated"}', true);
SELECT is((SELECT count(*)::int FROM public.proposals), 1, 'a viewer can read proposals');
UPDATE public.proposals SET title = 'hijacked' WHERE title = 'Website rebuild';
SELECT is((SELECT count(*)::int FROM public.proposals WHERE title = 'hijacked'), 0, 'a viewer cannot edit a proposal');

SELECT set_config('request.jwt.claims', '{"sub":"88888888-8888-8888-8888-888888888881","role":"authenticated"}', true);
UPDATE public.proposals SET price_notes = 'Paid in two halves' WHERE title = 'Website rebuild';
SELECT is((SELECT price_notes FROM public.proposals WHERE title = 'Website rebuild'), 'Paid in two halves', 'the owner can edit');

SELECT * FROM finish();
ROLLBACK;
