BEGIN;
SELECT plan(5);
SELECT has_table('public', 'agent_settings', 'agent_settings exists');
SELECT has_table('public', 'agent_controls', 'agent_controls exists');
SELECT ok(NOT has_table_privilege('authenticated', 'public.agent_settings', 'SELECT'), 'authenticated cannot read agent_settings');
SELECT ok(NOT has_table_privilege('anon', 'public.agent_controls', 'SELECT'), 'anon cannot read agent_controls');
SELECT throws_ok($$INSERT INTO public.agent_settings (organization_id, agent, autonomy_level) SELECT id, 'seo', 4 FROM public.organizations LIMIT 1$$, '23514', NULL, 'level above 3 rejected');
SELECT * FROM finish();
ROLLBACK;
