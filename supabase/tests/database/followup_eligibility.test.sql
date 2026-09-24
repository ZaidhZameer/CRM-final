BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT extensions.plan(4);

INSERT INTO auth.users (id, email) VALUES ('66666666-6666-6666-6666-666666666666', 'pecr@t.test');
CREATE TEMP TABLE ctx AS
SELECT p.default_organization_id AS org FROM public.profiles p
WHERE p.user_id = '66666666-6666-6666-6666-666666666666';

INSERT INTO public.leads (organization_id, source) SELECT org, 'csv_import' FROM ctx;
INSERT INTO public.leads (organization_id, source) SELECT org, 'web_form' FROM ctx;

SELECT throws_ok($$
  INSERT INTO public.follow_ups (organization_id, lead_id, scheduled_for, source)
  SELECT l.organization_id, l.id, now() + interval '3 days', 'automation'
  FROM public.leads l JOIN ctx c ON c.org = l.organization_id WHERE l.source = 'csv_import'
$$, 'P0001', 'follow_up_blocked: not_eligible_pecr',
  'automation cannot follow up an imported lead that is not a corporate subscriber');

SELECT lives_ok($$
  INSERT INTO public.follow_ups (organization_id, lead_id, scheduled_for, source)
  SELECT l.organization_id, l.id, now() + interval '3 days', 'user'
  FROM public.leads l JOIN ctx c ON c.org = l.organization_id WHERE l.source = 'csv_import'
$$, 'a human can still schedule a follow-up for that lead');

DELETE FROM public.follow_ups WHERE organization_id = (SELECT org FROM ctx);
UPDATE public.leads SET is_corporate_subscriber = true
WHERE organization_id = (SELECT org FROM ctx) AND source = 'csv_import';

SELECT lives_ok($$
  INSERT INTO public.follow_ups (organization_id, lead_id, scheduled_for, source)
  SELECT l.organization_id, l.id, now() + interval '3 days', 'automation'
  FROM public.leads l JOIN ctx c ON c.org = l.organization_id WHERE l.source = 'csv_import'
$$, 'once marked a corporate subscriber, automation may follow up');

SELECT lives_ok($$
  INSERT INTO public.follow_ups (organization_id, lead_id, scheduled_for, source)
  SELECT l.organization_id, l.id, now() + interval '3 days', 'automation'
  FROM public.leads l JOIN ctx c ON c.org = l.organization_id WHERE l.source = 'web_form'
$$, 'someone who enquired through a form can be followed up automatically');

SELECT * FROM finish();
ROLLBACK;
