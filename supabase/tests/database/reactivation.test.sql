BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT extensions.plan(17);

INSERT INTO auth.users (id, email) VALUES ('77777777-7777-7777-7777-777777777771', 'owner@react.test');
CREATE TEMP TABLE ctx AS
SELECT default_organization_id AS org FROM public.profiles WHERE user_id = '77777777-7777-7777-7777-777777777771';

-- Contacts 1..13, one lead each, all idle for 8 months unless noted.
INSERT INTO public.contacts (id, organization_id, full_name, email)
SELECT ('c1000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, org, 'Person ' || n, 'p' || n || '@react.test'
FROM ctx, generate_series(1, 13) n;

-- 1 eligible nurture (web_form, oldest)     2 eligible contacted (web_form)
-- 3 lost                                    4 do_not_contact
-- 5 recently updated                        6 csv_import, not a corporate subscriber (PECR)
-- 7 converted                               8 status new
-- 9 recent sent outreach                    10 pending follow-up
-- 11 deleted                                12 open deal
-- 13 pipeline_stage lost
INSERT INTO public.leads (id, organization_id, contact_id, source, status, created_at, updated_at, do_not_contact, deleted_at)
SELECT ('10000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, org,
       ('c1000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
       CASE WHEN n = 6 THEN 'csv_import' ELSE 'web_form' END,
       (CASE n WHEN 1 THEN 'nurture' WHEN 3 THEN 'lost' WHEN 7 THEN 'converted' WHEN 8 THEN 'new' ELSE 'contacted' END)::public.lead_status,
       now() - interval '1 year' + (n || ' days')::interval,
       CASE WHEN n = 5 THEN now() - interval '5 days' ELSE now() - interval '8 months' + (n || ' days')::interval END,
       n = 4,
       CASE WHEN n = 11 THEN now() - interval '8 months' END
FROM ctx, generate_series(1, 13) n;
UPDATE public.leads SET pipeline_stage = 'lost' WHERE id = '10000000-0000-0000-0000-000000000013';

INSERT INTO public.outreach_messages (organization_id, lead_id, body, status, sent_at)
SELECT org, '10000000-0000-0000-0000-000000000009'::uuid, 'Hi', 'sent', now() - interval '10 days' FROM ctx;
INSERT INTO public.follow_ups (organization_id, lead_id, scheduled_for, source)
SELECT org, '10000000-0000-0000-0000-000000000010'::uuid, now() + interval '2 days', 'automation' FROM ctx;
INSERT INTO public.deals (organization_id, lead_id, title)
SELECT org, '10000000-0000-0000-0000-000000000012'::uuid, 'Open deal' FROM ctx;

-- kind column ---------------------------------------------------------------
SELECT col_default_is('public', 'follow_ups', 'kind', 'follow_up'::text, 'follow_ups.kind defaults to follow_up');
SELECT throws_ok($$
  INSERT INTO public.follow_ups (organization_id, lead_id, scheduled_for, kind)
  SELECT org, '10000000-0000-0000-0000-000000000005'::uuid, now() + interval '1 day', 'bogus' FROM ctx
$$, '23514', NULL, 'follow_ups.kind only allows follow_up or reactivation');

-- eligibility -------------------------------------------------------------------
SELECT is(
  (SELECT array_agg(lead_id::text ORDER BY lead_id) FROM app.reactivation_candidates(90, 25)
   WHERE organization_id = (SELECT org FROM ctx)),
  ARRAY['10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002'],
  'only the two quiet, open, contactable, PECR-eligible leads qualify');

SELECT is(
  (SELECT lead_id::text FROM app.reactivation_candidates(90, 25)
   WHERE organization_id = (SELECT org FROM ctx) ORDER BY last_activity_at ASC LIMIT 1),
  '10000000-0000-0000-0000-000000000001', 'oldest quiet lead comes first');

SELECT is(
  (SELECT count(*)::int FROM app.reactivation_candidates(90, 1) WHERE organization_id = (SELECT org FROM ctx)),
  1, 'the per-org cap applies');

-- an old lead with fresh logged activity is not quiet
INSERT INTO public.activity_logs (organization_id, entity_type, entity_id, action)
SELECT org, 'lead', '10000000-0000-0000-0000-000000000002'::uuid, 'updated' FROM ctx;
SELECT is(
  (SELECT count(*)::int FROM app.reactivation_candidates(90, 25)
   WHERE organization_id = (SELECT org FROM ctx) AND lead_id = '10000000-0000-0000-0000-000000000002'),
  0, 'recent activity_logs entry makes a lead not quiet');
DELETE FROM public.activity_logs WHERE entity_id = '10000000-0000-0000-0000-000000000002';

-- A suppressed email is never a candidate even if the lead row was not flagged.
INSERT INTO public.contact_suppressions (organization_id, email_sha256)
SELECT org, app.email_sha256('p2@react.test') FROM ctx;
SELECT is(
  (SELECT count(*)::int FROM app.reactivation_candidates(90, 25)
   WHERE organization_id = (SELECT org FROM ctx) AND lead_id = '10000000-0000-0000-0000-000000000002'),
  0, 'a suppressed email is never a candidate');
DELETE FROM public.contact_suppressions WHERE email_sha256 = app.email_sha256('p2@react.test');

-- scheduling --------------------------------------------------------------------
SELECT lives_ok($$ SELECT * FROM app.schedule_reactivations('2026-10-02T08:30:00Z'::timestamptz) $$,
  'schedule_reactivations runs');

SELECT is(
  (SELECT count(*)::int FROM public.follow_ups
   WHERE organization_id = (SELECT org FROM ctx) AND kind = 'reactivation'),
  2, 'one reactivation follow-up per eligible lead');

SELECT results_eq($$
  SELECT source, step::int, decided_by, reason, status::text, scheduled_for::text
  FROM public.follow_ups WHERE lead_id = '10000000-0000-0000-0000-000000000001' AND kind = 'reactivation'
$$, $$ VALUES ('automation', 1, 'rule', 'Reactivation: quarterly check-in', 'pending', '2026-10-02 08:30:00+00') $$,
  'rows are automation / step 1 / rule / pending at the requested time');

SELECT is(
  (SELECT scheduled FROM app.schedule_reactivations('2026-10-02T08:30:00Z'::timestamptz)),
  0, 'running again schedules nothing for these leads (idempotent)');

-- completed or skipped reactivation still blocks another for 90 days
UPDATE public.follow_ups SET status = 'completed' WHERE kind = 'reactivation' AND organization_id = (SELECT org FROM ctx);
SELECT is(
  (SELECT count(*)::int FROM app.reactivation_candidates(90, 25) WHERE organization_id = (SELECT org FROM ctx)),
  0, 'a lead reactivated in the last 90 days is not a candidate again');

-- the interlock is unchanged: lost / closed / DNC leads are still refused for automation
SELECT throws_ok($$
  INSERT INTO public.follow_ups (organization_id, lead_id, scheduled_for, source, kind)
  SELECT org, '10000000-0000-0000-0000-000000000003'::uuid, now() + interval '1 day', 'automation', 'reactivation' FROM ctx
$$, 'P0001', 'follow_up_blocked: lead_closed', 'a lost lead is still refused, even for reactivation');

SELECT throws_ok($$
  INSERT INTO public.follow_ups (organization_id, lead_id, scheduled_for, source, kind)
  SELECT org, '10000000-0000-0000-0000-000000000004'::uuid, now() + interval '1 day', 'automation', 'reactivation' FROM ctx
$$, 'P0001', 'follow_up_blocked: do_not_contact', 'a do-not-contact lead is still refused for reactivation');

SELECT throws_ok($$
  INSERT INTO public.follow_ups (organization_id, lead_id, scheduled_for, source, kind)
  SELECT org, '10000000-0000-0000-0000-000000000006'::uuid, now() + interval '1 day', 'automation', 'reactivation' FROM ctx
$$, 'P0001', 'follow_up_blocked: not_eligible_pecr', 'PECR is still enforced for reactivation');

-- privileges ----------------------------------------------------------------------
SELECT ok(NOT has_function_privilege('authenticated', 'public.schedule_reactivations(timestamptz,int,int)', 'execute'),
  'signed-in users cannot run reactivation scheduling');
SELECT ok(has_function_privilege('service_role', 'public.schedule_reactivations(timestamptz,int,int)', 'execute'),
  'the service role can');

SELECT * FROM finish();
ROLLBACK;
