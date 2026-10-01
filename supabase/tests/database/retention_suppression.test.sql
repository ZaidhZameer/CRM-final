BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT extensions.plan(13);

INSERT INTO auth.users (id, email) VALUES ('99999999-9999-9999-9999-999999999991', 'owner@r.test');
CREATE TEMP TABLE ctx AS
SELECT default_organization_id AS org FROM public.profiles WHERE user_id = '99999999-9999-9999-9999-999999999991';
GRANT SELECT ON ctx TO authenticated;

INSERT INTO public.contacts (id, organization_id, full_name, email, phone, job_title, linkedin_url)
SELECT ('c0000000-0000-0000-0000-00000000000' || n)::uuid, org, 'Person ' || n, 'p' || n || '@x.test', '0700', 'CEO', 'https://li/' || n
FROM ctx, generate_series(1, 5) n;

-- 1 stale, 2 recent, 3 stale+converted, 4 stale+open deal, 5 stale+do_not_contact
INSERT INTO public.leads (id, organization_id, contact_id, status, created_at, updated_at, booking_answers_json, do_not_contact)
SELECT ('10000000-0000-0000-0000-00000000000' || n)::uuid, org, ('c0000000-0000-0000-0000-00000000000' || n)::uuid,
       CASE WHEN n = 3 THEN 'converted'::public.lead_status ELSE 'new'::public.lead_status END,
       CASE WHEN n = 2 THEN now() ELSE now() - interval '14 months' END,
       CASE WHEN n = 2 THEN now() ELSE now() - interval '14 months' END,
       '{"q":"secret"}'::jsonb, n = 5
FROM ctx, generate_series(1, 5) n;
INSERT INTO public.deals (organization_id, lead_id, title)
SELECT org, '10000000-0000-0000-0000-000000000004'::uuid, 'Open deal' FROM ctx;
INSERT INTO public.research_reports (organization_id, lead_id, company_summary)
SELECT org, '10000000-0000-0000-0000-000000000001'::uuid, 'summary' FROM ctx
UNION ALL SELECT org, '10000000-0000-0000-0000-000000000002'::uuid, 'summary' FROM ctx;
INSERT INTO public.outreach_messages (organization_id, lead_id, body, to_email)
SELECT org, '10000000-0000-0000-0000-000000000001'::uuid, 'Hello', 'p1@x.test' FROM ctx;
INSERT INTO public.lead_forms (id, organization_id, name, slug)
SELECT '20000000-0000-0000-0000-000000000001', org, 'F', 'retention-test-form' FROM ctx;
INSERT INTO public.lead_form_submissions (form_id, organization_id, data_json, converted_lead_id)
SELECT '20000000-0000-0000-0000-000000000001', org, '{"email":"p1@x.test"}', '10000000-0000-0000-0000-000000000001' FROM ctx;

SELECT ok(app.anonymise_stale_leads(12) >= 2, 'anonymiser processes the stale leads (1 and 5)');

SELECT is((SELECT full_name || coalesce(email, '-') || coalesce(phone, '-') FROM public.contacts WHERE id = 'c0000000-0000-0000-0000-000000000001'),
  'Anonymised--', 'stale lead contact is anonymised');
SELECT ok((SELECT booking_answers_json IS NULL AND deleted_at IS NOT NULL FROM public.leads WHERE id = '10000000-0000-0000-0000-000000000001'),
  'stale lead booking answers cleared and soft-deleted');
SELECT ok((SELECT data_json = '{}'::jsonb FROM public.lead_form_submissions WHERE converted_lead_id = '10000000-0000-0000-0000-000000000001')
  AND (SELECT body = '[removed]' AND to_email IS NULL FROM public.outreach_messages WHERE lead_id = '10000000-0000-0000-0000-000000000001')
  AND NOT EXISTS (SELECT 1 FROM public.research_reports WHERE lead_id = '10000000-0000-0000-0000-000000000001'),
  'submission, outreach and research data removed');
SELECT is((SELECT count(*)::int FROM public.contact_suppressions s, ctx WHERE s.organization_id = ctx.org AND s.email_sha256 = app.email_sha256('p1@x.test')),
  0, 'non-opted-out lead leaves no suppression row');

SELECT is((SELECT full_name FROM public.contacts WHERE id = 'c0000000-0000-0000-0000-000000000002'), 'Person 2', 'recent lead contact untouched');
SELECT ok((SELECT deleted_at IS NULL AND booking_answers_json IS NOT NULL FROM public.leads WHERE id = '10000000-0000-0000-0000-000000000002')
  AND EXISTS (SELECT 1 FROM public.research_reports WHERE lead_id = '10000000-0000-0000-0000-000000000002'), 'recent lead untouched');
SELECT ok((SELECT deleted_at IS NULL AND booking_answers_json IS NOT NULL FROM public.leads WHERE id = '10000000-0000-0000-0000-000000000003')
  AND (SELECT full_name FROM public.contacts WHERE id = 'c0000000-0000-0000-0000-000000000003') = 'Person 3', 'converted lead untouched');
SELECT ok((SELECT deleted_at IS NULL FROM public.leads WHERE id = '10000000-0000-0000-0000-000000000004')
  AND (SELECT full_name FROM public.contacts WHERE id = 'c0000000-0000-0000-0000-000000000004') = 'Person 4', 'lead with open deal untouched');

SELECT is((SELECT count(*)::int FROM public.contact_suppressions s, ctx WHERE s.organization_id = ctx.org AND s.email_sha256 = encode(sha256('p5@x.test'::bytea), 'hex')),
  1, 'do-not-contact lead leaves a hashed suppression row');
SELECT is((SELECT full_name FROM public.contacts WHERE id = 'c0000000-0000-0000-0000-000000000005'), 'Anonymised', 'do-not-contact lead is still anonymised');

-- Intake: new lead with a suppressed email starts as do-not-contact; others do not.
INSERT INTO public.contacts (id, organization_id, full_name, email)
SELECT 'c0000000-0000-0000-0000-000000000006', org, 'Returning', '  P5@X.test ' FROM ctx;
INSERT INTO public.contacts (id, organization_id, full_name, email)
SELECT 'c0000000-0000-0000-0000-000000000007', org, 'Fresh', 'fresh@x.test' FROM ctx;
INSERT INTO public.leads (id, organization_id, contact_id, source)
SELECT '10000000-0000-0000-0000-000000000006'::uuid, org, 'c0000000-0000-0000-0000-000000000006'::uuid, 'web_form' FROM ctx
UNION ALL SELECT '10000000-0000-0000-0000-000000000007'::uuid, org, 'c0000000-0000-0000-0000-000000000007'::uuid, 'web_form' FROM ctx;
SELECT ok((SELECT do_not_contact AND do_not_contact_at IS NOT NULL FROM public.leads WHERE id = '10000000-0000-0000-0000-000000000006')
  AND NOT (SELECT do_not_contact FROM public.leads WHERE id = '10000000-0000-0000-0000-000000000007'),
  'new lead with suppressed email (case/space-insensitive) is do-not-contact; others are not');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"99999999-9999-9999-9999-999999999991","role":"authenticated"}', true);
SELECT throws_ok($$ SELECT * FROM public.contact_suppressions $$, '42501', NULL, 'authenticated users cannot read contact_suppressions');

SELECT * FROM finish();
ROLLBACK;
