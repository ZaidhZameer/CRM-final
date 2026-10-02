BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT extensions.plan(6);

INSERT INTO auth.users (id, email) VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1', 'cold@t.test');
CREATE TEMP TABLE ctx AS SELECT default_organization_id AS org FROM public.profiles WHERE user_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1';
INSERT INTO public.leads (organization_id, source, is_corporate_subscriber) SELECT org, 'companies_house', true FROM ctx;
INSERT INTO public.leads (organization_id, source, is_corporate_subscriber) SELECT org, 'import_cqc', true FROM ctx;
INSERT INTO public.leads (organization_id, source) SELECT org, 'web_form' FROM ctx;

CREATE FUNCTION pg_temp.reason(src text) RETURNS text LANGUAGE sql AS $$
  SELECT app.contact_block_reason((SELECT id FROM public.leads WHERE source = src LIMIT 1), 'automation') $$;

SELECT is(pg_temp.reason('companies_house'), 'cold_sending_not_confirmed', 'a sourced lead is blocked until cold sending is confirmed');
SELECT is(pg_temp.reason('import_cqc'), 'cold_sending_not_confirmed', 'an imported lead is blocked too');
SELECT is(pg_temp.reason('web_form'), NULL, 'someone who enquired is not affected');

SELECT throws_ok($$
  INSERT INTO public.follow_ups (organization_id, lead_id, scheduled_for, source)
  SELECT l.organization_id, l.id, now() + interval '3 days', 'automation' FROM public.leads l WHERE l.source = 'companies_house'
$$, 'P0001', 'follow_up_blocked: cold_sending_not_confirmed', 'the follow-up interlock refuses a cold lead');

INSERT INTO public.sourcing_settings (organization_id, cold_sending_confirmed) SELECT org, true FROM ctx;
SELECT is(pg_temp.reason('companies_house'), NULL, 'once the owner confirms a separate sending domain, automation is allowed');
SELECT is(app.contact_block_reason((SELECT id FROM public.leads WHERE source = 'companies_house' LIMIT 1), 'user'), NULL, 'a human can always email, with or without the guard');

SELECT * FROM finish();
ROLLBACK;
