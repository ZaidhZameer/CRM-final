BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT extensions.plan(6);

INSERT INTO auth.users (id, email) VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 'src@t.test');
CREATE TEMP TABLE ctx AS SELECT default_organization_id AS org FROM public.profiles WHERE user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1';
INSERT INTO public.sourcing_settings (organization_id) SELECT org FROM ctx;

SELECT is((SELECT enabled FROM public.sourcing_settings WHERE organization_id = (SELECT org FROM ctx)), false, 'sourcing is OFF by default');
SELECT is((SELECT cold_sending_confirmed FROM public.sourcing_settings WHERE organization_id = (SELECT org FROM ctx)), false, 'cold sending is unconfirmed by default');
SELECT is((SELECT daily_cap::int FROM public.sourcing_settings WHERE organization_id = (SELECT org FROM ctx)), 10, 'default daily cap is 10');
SELECT throws_ok($$ UPDATE public.sourcing_settings SET daily_cap = 500 WHERE organization_id = (SELECT org FROM ctx) $$, '23514', NULL, 'the daily cap is bounded');

INSERT INTO public.sourced_companies (organization_id, company_number, name) SELECT org, '01234567', 'Harbor Dental Ltd' FROM ctx;
SELECT throws_ok($$ INSERT INTO public.sourced_companies (organization_id, company_number, name) SELECT org, '01234567', 'Harbor Dental Ltd' FROM ctx $$,
  '23505', NULL, 'a company is only recorded once per org');

SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT * FROM public.sourced_companies $$, '42501', NULL, 'members cannot read sourcing tables directly');

SELECT * FROM finish();
ROLLBACK;
