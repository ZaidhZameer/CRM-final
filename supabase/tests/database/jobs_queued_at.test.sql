BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT extensions.plan(3);

INSERT INTO auth.users (id, email) VALUES ('55555555-5555-5555-5555-555555555555', 'jq@t.test');
CREATE TEMP TABLE ctx AS
SELECT p.default_organization_id AS org FROM public.profiles p
WHERE p.user_id = '55555555-5555-5555-5555-555555555555';

-- A job drafted 2 hours ago that has been waiting for a human decision.
INSERT INTO public.jobs (organization_id, job_type, status, created_at)
SELECT org, 'test.wait', 'awaiting_approval', now() - interval '2 hours' FROM ctx;

SELECT is((SELECT queued_at FROM public.jobs WHERE job_type = 'test.wait'), NULL,
  'a job awaiting approval has no queued_at');

UPDATE public.jobs SET status = 'queued' WHERE job_type = 'test.wait';
SELECT ok((SELECT queued_at > now() - interval '1 minute' FROM public.jobs WHERE job_type = 'test.wait'),
  'approving it stamps queued_at now, not at creation (the sweep must not kill it)');

INSERT INTO public.jobs (organization_id, job_type, status) SELECT org, 'test.direct', 'queued' FROM ctx;
SELECT isnt((SELECT queued_at FROM public.jobs WHERE job_type = 'test.direct'), NULL,
  'a job inserted as queued is stamped too');

SELECT * FROM finish();
ROLLBACK;
