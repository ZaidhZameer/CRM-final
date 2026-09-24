BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT extensions.plan(5);

-- Two orgs: A has alice + bob, B has carol.
INSERT INTO auth.users (id, email) VALUES
  ('11111111-1111-1111-1111-111111111111', 'alice@t.test'),
  ('22222222-2222-2222-2222-222222222222', 'bob@t.test'),
  ('33333333-3333-3333-3333-333333333333', 'carol@t.test');

CREATE TEMP TABLE ids AS
SELECT
  (SELECT id FROM public.profiles WHERE user_id = '11111111-1111-1111-1111-111111111111') AS alice,
  (SELECT id FROM public.profiles WHERE user_id = '22222222-2222-2222-2222-222222222222') AS bob,
  (SELECT id FROM public.profiles WHERE user_id = '33333333-3333-3333-3333-333333333333') AS carol;
GRANT SELECT ON ids TO authenticated;

-- Signup trigger gives everyone their own workspace; put bob into alice's workspace too.
INSERT INTO public.memberships (organization_id, profile_id, role, status)
SELECT p.default_organization_id, (SELECT bob FROM ids), 'sales', 'active'
FROM public.profiles p WHERE p.id = (SELECT alice FROM ids);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

SELECT lives_ok($$ SELECT count(*) FROM public.profiles $$, 'user client can read profiles (no policy recursion)');
SELECT is((SELECT count(*)::int FROM public.profiles WHERE id = (SELECT alice FROM ids)), 1, 'alice sees her own profile');
SELECT is((SELECT count(*)::int FROM public.profiles WHERE id = (SELECT bob FROM ids)), 1, 'alice sees a teammate');
SELECT is((SELECT count(*)::int FROM public.profiles WHERE id = (SELECT carol FROM ids)), 0, 'alice cannot see a profile from another org');

SELECT set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
SELECT is((SELECT count(*)::int FROM public.profiles WHERE id IN ((SELECT alice FROM ids), (SELECT bob FROM ids))), 0, 'carol cannot see org A profiles');

SELECT * FROM finish();
ROLLBACK;
