-- Phase 1: tenant isolation, approvals, and database-enforced interlocks.
-- Run with: npx supabase test db
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(31);

-- ---------------------------------------------------------------------------
-- Fixtures. The auth trigger gives each user a profile, a personal org, and
-- an owner membership. User C also joins org A as a viewer.
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'a@phase1.test', '{"full_name":"User A"}'),
  ('b0000000-0000-4000-8000-000000000001', 'b@phase1.test', '{"full_name":"User B"}'),
  ('c0000000-0000-4000-8000-000000000001', 'c@phase1.test', '{"full_name":"User C"}');

SELECT set_config('t.org_a', (SELECT m.organization_id::text FROM memberships m JOIN profiles p ON p.id = m.profile_id
  WHERE p.user_id = 'a0000000-0000-4000-8000-000000000001'), true);
SELECT set_config('t.org_b', (SELECT m.organization_id::text FROM memberships m JOIN profiles p ON p.id = m.profile_id
  WHERE p.user_id = 'b0000000-0000-4000-8000-000000000001'), true);

INSERT INTO memberships (profile_id, organization_id, role, status)
SELECT p.id, current_setting('t.org_a')::uuid, 'viewer', 'active'
FROM profiles p WHERE p.user_id = 'c0000000-0000-4000-8000-000000000001';

INSERT INTO leads (id, organization_id, status, do_not_contact) VALUES
  ('10000000-0000-4000-8000-00000000000a', current_setting('t.org_a')::uuid, 'new',  false), -- plain A
  ('10000000-0000-4000-8000-00000000000b', current_setting('t.org_b')::uuid, 'new',  false), -- plain B
  ('10000000-0000-4000-8000-0000000000d1', current_setting('t.org_a')::uuid, 'new',  true),  -- do not contact
  ('10000000-0000-4000-8000-0000000000c1', current_setting('t.org_a')::uuid, 'lost', false), -- closed
  ('10000000-0000-4000-8000-0000000000e1', current_setting('t.org_a')::uuid, 'new',  false), -- has future meeting
  ('10000000-0000-4000-8000-0000000000f1', current_setting('t.org_a')::uuid, 'new',  false), -- has a pending follow-up
  ('10000000-0000-4000-8000-0000000000f2', current_setting('t.org_a')::uuid, 'new',  false), -- kill switch
  ('10000000-0000-4000-8000-0000000000f3', current_setting('t.org_a')::uuid, 'new',  false), -- DNC flip
  ('10000000-0000-4000-8000-0000000000f4', current_setting('t.org_a')::uuid, 'new',  false); -- meeting pause

INSERT INTO meetings (organization_id, lead_id, title, start_time, end_time, status) VALUES
  (current_setting('t.org_a')::uuid, '10000000-0000-4000-8000-0000000000e1', 'Intro',
   now() + interval '2 days', now() + interval '2 days 30 minutes', 'scheduled');

INSERT INTO follow_ups (organization_id, lead_id, scheduled_for, status, source) VALUES
  (current_setting('t.org_a')::uuid, '10000000-0000-4000-8000-0000000000f1', now() + interval '1 day', 'pending', 'user'),
  (current_setting('t.org_a')::uuid, '10000000-0000-4000-8000-0000000000f2', now() + interval '1 day', 'pending', 'automation'),
  (current_setting('t.org_a')::uuid, '10000000-0000-4000-8000-0000000000f3', now() + interval '1 day', 'pending', 'user'),
  (current_setting('t.org_a')::uuid, '10000000-0000-4000-8000-0000000000f4', now() + interval '1 day', 'pending', 'automation');

INSERT INTO companies (organization_id, name) VALUES (current_setting('t.org_b')::uuid, 'B Corp');
INSERT INTO client_context (organization_id, services) VALUES (current_setting('t.org_b')::uuid, 'B services');

INSERT INTO jobs (id, organization_id, job_type, status) VALUES
  ('20000000-0000-4000-8000-00000000000b', current_setting('t.org_b')::uuid, 'lead.enrichment', 'done'),
  ('20000000-0000-4000-8000-0000000000a3', current_setting('t.org_a')::uuid, 'content.draft', 'awaiting_approval');

INSERT INTO approvals (id, organization_id, job_id, action_type, tier, title) VALUES
  ('30000000-0000-4000-8000-00000000000b', current_setting('t.org_b')::uuid, NULL, 'content.publish', 'review', 'B approval'),
  ('30000000-0000-4000-8000-0000000000a1', current_setting('t.org_a')::uuid, NULL, 'content.publish', 'review', 'A1'),
  ('30000000-0000-4000-8000-0000000000a2', current_setting('t.org_a')::uuid, NULL, 'task.assign', 'always_human', 'A2'),
  ('30000000-0000-4000-8000-0000000000a3', current_setting('t.org_a')::uuid,
   '20000000-0000-4000-8000-0000000000a3', 'content.publish', 'review', 'A3');

-- ---------------------------------------------------------------------------
-- Structure and privileges
-- ---------------------------------------------------------------------------
SELECT is((SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity), 0,
  'every public table has row-level security enabled');
SELECT ok(NOT has_table_privilege('anon', 'public.api_rate_limits', 'SELECT'),
  'anon can no longer read api_rate_limits');
SELECT ok(NOT has_table_privilege('authenticated', 'public.jobs', 'INSERT'),
  'signed-in users cannot write jobs directly');

-- ---------------------------------------------------------------------------
-- Tenant isolation, as user A
-- ---------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

SELECT is((SELECT count(*)::int FROM leads WHERE id = '10000000-0000-4000-8000-00000000000a'), 1,
  'A sees its own lead (control)');
SELECT is((SELECT count(*)::int FROM leads WHERE organization_id = current_setting('t.org_b')::uuid), 0,
  'A cannot see org B leads');
SELECT is((SELECT count(*)::int FROM companies WHERE organization_id = current_setting('t.org_b')::uuid), 0,
  'A cannot see org B companies');
SELECT is((SELECT count(*)::int FROM jobs WHERE organization_id = current_setting('t.org_b')::uuid), 0,
  'A cannot see org B jobs');
SELECT is((SELECT count(*)::int FROM approvals WHERE organization_id = current_setting('t.org_b')::uuid), 0,
  'A cannot see org B approvals');
SELECT is((SELECT count(*)::int FROM client_context WHERE organization_id = current_setting('t.org_b')::uuid), 0,
  'A cannot see org B client context');
SELECT throws_ok(
  format('INSERT INTO leads (organization_id) VALUES (%L)', current_setting('t.org_b')),
  '42501', NULL, 'A cannot create a lead in org B');
SELECT results_eq(
  format('WITH u AS (UPDATE leads SET source = %L WHERE organization_id = %L RETURNING 1) SELECT count(*)::int FROM u',
         'tampered', current_setting('t.org_b')),
  $$VALUES (0)$$, 'A cannot update org B leads');
SELECT throws_ok(
  format('INSERT INTO jobs (organization_id, job_type) VALUES (%L, %L)', current_setting('t.org_a'), 'x'),
  '42501', NULL, 'A cannot insert jobs even in its own org');
SELECT lives_ok(
  format('INSERT INTO client_context (organization_id, services) VALUES (%L, %L)', current_setting('t.org_a'), 'A services'),
  'A can write its own client context');

-- ---------------------------------------------------------------------------
-- Approvals, as user A (owner of org A)
-- ---------------------------------------------------------------------------
SELECT throws_ok($$SELECT decide_approval('30000000-0000-4000-8000-00000000000b', 'approved', 1)$$,
  'P0001', 'approval_not_found', 'A cannot decide an org B approval (and cannot tell it exists)');
SELECT is((SELECT (decide_approval('30000000-0000-4000-8000-0000000000a1', 'approved', 1)).status::text), 'approved',
  'owner can approve');
SELECT is((SELECT version FROM approvals WHERE id = '30000000-0000-4000-8000-0000000000a1'), 2,
  'deciding bumps the version');
SELECT throws_ok($$SELECT decide_approval('30000000-0000-4000-8000-0000000000a1', 'rejected', 2)$$,
  'P0001', 'approval_not_pending', 'an approval cannot be decided twice');
SELECT throws_ok($$SELECT decide_approval('30000000-0000-4000-8000-0000000000a2', 'approved', 99)$$,
  'P0001', 'version_conflict', 'a stale version is rejected');
SELECT throws_ok($$SELECT decide_approval('30000000-0000-4000-8000-0000000000a2', 'rejected', 1, NULL, '{"x":1}')$$,
  'P0001', 'edits_require_approval', 'edits only allowed when approving');
SELECT is((SELECT (decide_approval('30000000-0000-4000-8000-0000000000a3', 'approved', 1)).status::text), 'approved',
  'approving a job-linked approval succeeds');
SELECT is((SELECT status::text FROM jobs WHERE id = '20000000-0000-4000-8000-0000000000a3'), 'queued',
  'approving releases the waiting job');

-- As user C (viewer in org A)
SELECT set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
SELECT throws_ok($$SELECT decide_approval('30000000-0000-4000-8000-0000000000a2', 'approved', 1)$$,
  'P0001', 'not_allowed', 'a viewer cannot decide approvals');
RESET ROLE;

-- ---------------------------------------------------------------------------
-- Interlocks (enforced for every writer, including the service role)
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  format('INSERT INTO follow_ups (organization_id, lead_id, scheduled_for, source) VALUES (%L, %L, now(), %L)',
         current_setting('t.org_a'), '10000000-0000-4000-8000-0000000000d1', 'user'),
  'P0001', 'follow_up_blocked: do_not_contact', 'do-not-contact blocks follow-ups, even from a person');
SELECT throws_ok(
  format('INSERT INTO follow_ups (organization_id, lead_id, scheduled_for, source) VALUES (%L, %L, now(), %L)',
         current_setting('t.org_a'), '10000000-0000-4000-8000-0000000000c1', 'automation'),
  'P0001', 'follow_up_blocked: lead_closed', 'a closed lead blocks automation follow-ups');
SELECT lives_ok(
  format('INSERT INTO follow_ups (organization_id, lead_id, scheduled_for, source) VALUES (%L, %L, now(), %L)',
         current_setting('t.org_a'), '10000000-0000-4000-8000-0000000000c1', 'user'),
  'a person can still follow up a closed lead');
SELECT throws_ok(
  format('INSERT INTO follow_ups (organization_id, lead_id, scheduled_for, source) VALUES (%L, %L, now(), %L)',
         current_setting('t.org_a'), '10000000-0000-4000-8000-0000000000e1', 'automation'),
  'P0001', 'follow_up_blocked: meeting_scheduled', 'a scheduled meeting pauses automation follow-ups');
SELECT throws_ok(
  format('INSERT INTO follow_ups (organization_id, lead_id, scheduled_for, source) VALUES (%L, %L, now(), %L)',
         current_setting('t.org_a'), '10000000-0000-4000-8000-0000000000f1', 'user'),
  'P0001', 'follow_up_blocked: pending_exists', 'only one pending follow-up per lead');

UPDATE leads SET status = 'lost' WHERE id = '10000000-0000-4000-8000-0000000000f2';
SELECT is((SELECT status::text FROM follow_ups WHERE lead_id = '10000000-0000-4000-8000-0000000000f2'), 'skipped',
  'kill switch: closing a lead skips its pending automation follow-up');

UPDATE leads SET do_not_contact = true WHERE id = '10000000-0000-4000-8000-0000000000f3';
SELECT is((SELECT status::text FROM follow_ups WHERE lead_id = '10000000-0000-4000-8000-0000000000f3'), 'skipped',
  'do-not-contact skips every pending follow-up, including a person''s');

SELECT throws_ok(
  format('INSERT INTO outreach_messages (organization_id, lead_id, body, status) VALUES (%L, %L, %L, %L)',
         current_setting('t.org_a'), '10000000-0000-4000-8000-0000000000d1', 'hi', 'sent'),
  'P0001', 'outreach_blocked: do_not_contact', 'do-not-contact blocks sending outreach');

INSERT INTO meetings (organization_id, lead_id, title, start_time, end_time, status) VALUES
  (current_setting('t.org_a')::uuid, '10000000-0000-4000-8000-0000000000f4', 'Call',
   now() + interval '3 days', now() + interval '3 days 30 minutes', 'scheduled');
SELECT is((SELECT status::text FROM follow_ups WHERE lead_id = '10000000-0000-4000-8000-0000000000f4'), 'skipped',
  'booking a meeting skips pending automation follow-ups');

SELECT * FROM finish();
ROLLBACK;
