// Integration tests against the LOCAL stack: Supabase (npx supabase start) + the app on :3000.
// Run: pnpm test:integration   (skipped otherwise, so CI and plain `vitest run` never need the stack)
// Each run creates a throwaway user/workspace and deletes it afterwards.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { findOpenLeadIdByEmail } from '@/lib/leads'

const enabled = process.env.FLOWLEAD_INTEGRATION === '1'
// Minimal .env.local reader (KEY=value, optional quotes); values are never logged.
function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}
const env = enabled ? { ...readEnvFile('.env.local'), ...process.env } as Record<string, string> : ({} as Record<string, string>)
const APP = env.INTEGRATION_APP_URL || 'http://localhost:3000'

describe.skipIf(!enabled)('automation integration (local stack)', () => {
  let db: SupabaseClient
  let userId: string
  let orgId: string

  const newLead = async (fields: Record<string, unknown> = {}) => {
    const { data, error } = await db.from('leads').insert({ organization_id: orgId, source: 'web_form', ...fields }).select('id, version').single()
    if (error) throw error
    return data as { id: string; version: number }
  }

  const postResult = (body: unknown) =>
    fetch(`${APP}/api/automation/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-flowlead-secret': env.AUTOMATION_SHARED_SECRET },
      body: JSON.stringify(body),
    })

  const enrichedEvent = (leadId: string, extra: Record<string, unknown> = {}) => ({
    event_id: randomUUID(),
    event_type: 'lead.enriched',
    organization_id: orgId,
    subject_id: leadId,
    correlation_id: randomUUID(),
    payload: { research: { status: 'completed', lead_score: 61 }, lead_update: { lead_score: 61, ai_status: 'completed' } },
    ...extra,
  })

  beforeAll(async () => {
    db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    const { data, error } = await db.auth.admin.createUser({ email: `int-${randomUUID()}@flowlead.test`, email_confirm: true })
    if (error) throw error
    userId = data.user.id
    const { data: profile } = await db.from('profiles').select('default_organization_id').eq('user_id', userId).single()
    orgId = profile!.default_organization_id
  })

  afterAll(async () => {
    if (!orgId) return
    for (const t of ['approvals', 'jobs', 'follow_ups', 'research_reports', 'ai_usage_log', 'automation_events', 'activity_logs', 'leads', 'contacts', 'companies']) {
      await db.from(t).delete().eq('organization_id', orgId)
    }
    await db.from('memberships').delete().eq('organization_id', orgId)
    await db.from('profiles').update({ default_organization_id: null }).eq('user_id', userId)
    await db.from('organizations').delete().eq('id', orgId)
    await db.auth.admin.deleteUser(userId)
  })

  it('a completed event delivered twice is answered as a duplicate and writes nothing more', async () => {
    const lead = await newLead()
    const event = enrichedEvent(lead.id)
    expect((await postResult(event)).status).toBe(200)

    const second = await postResult(event)
    expect(await second.json()).toMatchObject({ ok: true, duplicate: true })
    const { count } = await db.from('research_reports').select('id', { count: 'exact', head: true }).eq('lead_id', lead.id)
    expect(count).toBe(1)
  })

  it('a stale expected_version keeps the report but does not overwrite the lead', async () => {
    const lead = await newLead({ lead_score: 10 })
    await db.from('leads').update({ lead_score: 12, version: lead.version + 1 }).eq('id', lead.id) // a human edit

    const res = await postResult(enrichedEvent(lead.id, { expected_version: lead.version }))
    expect(await res.json()).toMatchObject({ ok: true, outcome: 'skipped_version_conflict' })
    const { data: after } = await db.from('leads').select('lead_score').eq('id', lead.id).single()
    expect(after!.lead_score).toBe(12)
  })

  it('schedules exactly one automated step-1 follow-up, even if enrichment runs again', async () => {
    const lead = await newLead()
    await postResult(enrichedEvent(lead.id))
    const { data: again } = await db.from('leads').select('version').eq('id', lead.id).single()
    await postResult(enrichedEvent(lead.id, { expected_version: again!.version }))

    const { data: fus } = await db.from('follow_ups').select('step, decided_by, source').eq('lead_id', lead.id)
    expect(fus).toEqual([{ step: 1, decided_by: 'rule', source: 'automation' }])
  })

  it('the lifecycle sweep fails a job queued 40 minutes ago but leaves a fresh one alone', async () => {
    const { data: jobs } = await db.from('jobs').insert([
      { organization_id: orgId, job_type: 'int.old', status: 'queued' },
      { organization_id: orgId, job_type: 'int.fresh', status: 'queued' },
    ]).select('id, job_type')
    const old = jobs!.find((j) => j.job_type === 'int.old')!
    await db.from('jobs').update({ queued_at: new Date(Date.now() - 40 * 60_000).toISOString() }).eq('id', old.id)

    const res = await fetch(`${APP}/api/cron/lifecycle`, { headers: { 'x-cron-secret': env.CRON_SECRET } })
    expect(res.status).toBe(200)
    const { data: after } = await db.from('jobs').select('job_type, status').eq('organization_id', orgId).like('job_type', 'int.%')
    expect(Object.fromEntries(after!.map((j) => [j.job_type, j.status]))).toEqual({ 'int.old': 'failed', 'int.fresh': 'queued' })
  })

  it('findOpenLeadIdByEmail returns the open lead and ignores lost or deleted ones', async () => {
    const email = `dup-${randomUUID()}@acme.test`
    const { data: contact } = await db.from('contacts').insert({ organization_id: orgId, full_name: 'Dup', email }).select('id').single()
    await newLead({ contact_id: contact!.id, status: 'lost' })
    await newLead({ contact_id: contact!.id, deleted_at: new Date().toISOString() })
    const open = await newLead({ contact_id: contact!.id, status: 'new' })

    expect(await findOpenLeadIdByEmail(db, orgId, email.toUpperCase())).toBe(open.id)
    expect(await findOpenLeadIdByEmail(db, orgId, `nobody-${randomUUID()}@acme.test`)).toBeNull()
  })
})
