BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT extensions.plan(4);

INSERT INTO auth.users (id, email) VALUES ('77777777-7777-7777-7777-777777777777', 'tok@t.test');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"77777777-7777-7777-7777-777777777777","role":"authenticated"}', true);

SELECT throws_ok($$ SELECT access_token FROM public.google_oauth_tokens $$, '42501', NULL,
  'a signed-in member cannot read Google OAuth tokens');
SELECT throws_ok($$ SELECT access_token FROM public.mail_connections $$, '42501', NULL,
  'a signed-in member cannot read mailbox tokens');
SELECT throws_ok($$ INSERT INTO public.mail_connections (organization_id, profile_id, email, access_token, token_expires_at)
  VALUES (gen_random_uuid(), gen_random_uuid(), 'x@y.z', 't', now()) $$, '42501', NULL,
  'a signed-in member cannot plant a mailbox connection');

RESET ROLE;
SET LOCAL ROLE anon;
SELECT throws_ok($$ SELECT refresh_token FROM public.google_oauth_tokens $$, '42501', NULL,
  'the anon key cannot read Google OAuth tokens');

SELECT * FROM finish();
ROLLBACK;
