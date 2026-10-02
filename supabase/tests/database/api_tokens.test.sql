BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT extensions.plan(11);

INSERT INTO auth.users (id, email) VALUES ('77777777-7777-7777-7777-777777777781', 'mcp@t.test');
CREATE TEMP TABLE ctx AS
SELECT p.id AS profile, p.default_organization_id AS org FROM public.profiles p WHERE p.user_id = '77777777-7777-7777-7777-777777777781';
GRANT SELECT ON ctx TO authenticated;

-- Service-level inserts (the test runs as the migration superuser) ----------------------------
SELECT lives_ok($$ INSERT INTO public.api_tokens (organization_id, profile_id, name, token_sha256, scopes)
  SELECT org, profile, 'Claude Desktop', repeat('a', 64), ARRAY['read', 'propose'] FROM ctx $$,
  'a valid token row inserts');
SELECT throws_ok($$ INSERT INTO public.api_tokens (organization_id, profile_id, name, token_sha256, scopes)
  SELECT org, profile, 'Dup', repeat('a', 64), ARRAY['read'] FROM ctx $$, '23505', NULL,
  'token hashes are unique');
SELECT throws_ok($$ INSERT INTO public.api_tokens (organization_id, profile_id, name, token_sha256, scopes)
  SELECT org, profile, 'Admin', repeat('b', 64), ARRAY['read', 'admin'] FROM ctx $$, '23514', NULL,
  'an unknown scope is rejected');
SELECT throws_ok($$ INSERT INTO public.api_tokens (organization_id, profile_id, name, token_sha256, scopes)
  SELECT org, profile, 'Empty', repeat('c', 64), ARRAY[]::text[] FROM ctx $$, '23514', NULL,
  'an empty scope list is rejected');
SELECT throws_ok($$ INSERT INTO public.api_tokens (organization_id, profile_id, name, token_sha256, scopes)
  SELECT org, profile, 'Bad hash', 'not-a-hash', ARRAY['read'] FROM ctx $$, '23514', NULL,
  'the hash must be 64 lowercase hex characters');
SELECT throws_ok($$ INSERT INTO public.api_tokens (organization_id, profile_id, name, token_sha256, scopes)
  SELECT org, profile, '', repeat('d', 64), ARRAY['read'] FROM ctx $$, '23514', NULL,
  'the name cannot be empty');
SELECT throws_ok($$ INSERT INTO public.api_tokens (organization_id, profile_id, name, token_sha256, scopes)
  SELECT org, profile, repeat('n', 81), repeat('e', 64), ARRAY['read'] FROM ctx $$, '23514', NULL,
  'the name is capped at 80 characters');

-- Signed-in users and anon cannot touch the table ---------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"77777777-7777-7777-7777-777777777781","role":"authenticated"}', true);
SELECT throws_ok($$ SELECT token_sha256 FROM public.api_tokens $$, '42501', NULL,
  'a signed-in user cannot read token hashes');
SELECT throws_ok($$ INSERT INTO public.api_tokens (organization_id, profile_id, name, token_sha256, scopes)
  SELECT org, profile, 'Mine', repeat('f', 64), ARRAY['read'] FROM ctx $$, '42501', NULL,
  'a signed-in user cannot mint a token directly');
RESET ROLE;
SET LOCAL ROLE anon;
SELECT throws_ok($$ SELECT id FROM public.api_tokens $$, '42501', NULL,
  'the anon key cannot read tokens');
RESET ROLE;
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.api_tokens'::regclass),
  'row level security is enabled');

SELECT * FROM finish();
ROLLBACK;
