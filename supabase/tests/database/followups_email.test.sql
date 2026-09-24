BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT extensions.plan(6);

INSERT INTO auth.users (id, email) VALUES ('44444444-4444-4444-4444-444444444444', 'fu@t.test');
CREATE TEMP TABLE ctx AS
SELECT p.default_organization_id AS org FROM public.profiles p
WHERE p.user_id = '44444444-4444-4444-4444-444444444444';

INSERT INTO public.leads (organization_id, source) SELECT org, 'test' FROM ctx;

SELECT lives_ok($$
  INSERT INTO public.outreach_messages (organization_id, lead_id, channel, status, body, gmail_message_id, gmail_thread_id)
  SELECT c.org, l.id, 'email', 'sent', 'hi', 'gm-1', 'th-1' FROM ctx c JOIN public.leads l ON l.organization_id = c.org
$$, 'a sent message with Gmail ids is accepted');

SELECT throws_ok($$
  INSERT INTO public.outreach_messages (organization_id, lead_id, channel, status, body, gmail_message_id)
  SELECT c.org, l.id, 'email', 'sent', 'hi again', 'gm-1' FROM ctx c JOIN public.leads l ON l.organization_id = c.org
$$, '23505', NULL, 'the same Gmail message cannot be recorded twice in one org');

SELECT throws_ok($$
  UPDATE public.outreach_messages SET reply_class = 'maybe' WHERE gmail_message_id = 'gm-1'
$$, '23514', NULL, 'reply_class only takes the known classes');

SELECT lives_ok($$
  UPDATE public.outreach_messages SET reply_class = 'unsubscribe', status = 'replied', replied_at = now()
  WHERE gmail_message_id = 'gm-1'
$$, 'a reply can be recorded with a known class');

SELECT throws_ok($$
  INSERT INTO public.follow_ups (organization_id, lead_id, scheduled_for, decided_by)
  SELECT c.org, l.id, now(), 'jev' FROM ctx c JOIN public.leads l ON l.organization_id = c.org
$$, '23514', NULL, 'decided_by only takes rule, ai or human');

SELECT is(
  (SELECT column_default FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'follow_ups' AND column_name = 'decided_by'),
  '''human''::text', 'follow-ups default to a human decision');

SELECT * FROM finish();
ROLLBACK;
