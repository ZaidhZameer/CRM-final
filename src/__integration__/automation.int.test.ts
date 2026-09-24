// Integration tests against the LOCAL stack: Supabase (npx supabase start) + the app on :3000.
// Run: pnpm test:integration   (skipped otherwise, so CI and plain `vitest run` never need the stack)
// Each run creates a throwaway user/workspace and deletes it afterwards.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { findOpenLeadIdByEmail } from '@/lib/leads'
import { queueApprovedFollowUp, closeRejectedFollowUp, sendDueFollowUps } from '@/lib/follow-up-sender'
import { applyReply } from '@/lib/reply-watcher'

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
    for (const t of ['tasks', 'mail_connections', 'approvals', 'outreach_messages', 'jobs', 'follow_ups', 'research_reports', 'ai_usage_log', 'automation_events', 'activity_logs', 'leads', 'contacts', 'companies']) {
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

  // ---- follow-up drafting (engine -> app) ---------------------------------------
  const pendingFollowUp = async () => {
    const { data: co } = await db.from('companies').insert({ organization_id: orgId, name: 'Draft Co' }).select('id').single()
    const { data: ct } = await db.from('contacts').insert({ organization_id: orgId, company_id: co!.id, full_name: 'Dana Draft', email: `dana-${randomUUID()}@draftco.test` }).select('id').single()
    const lead = await newLead({ company_id: co!.id, contact_id: ct!.id })
    const scheduled = new Date(Date.now() + 2 * 24 * 60 * 60_000).toISOString()
    const { data: fu, error } = await db.from('follow_ups').insert({ organization_id: orgId, lead_id: lead.id, scheduled_for: scheduled, source: 'automation', step: 1, decided_by: 'rule' }).select('id, scheduled_for').single()
    if (error) throw error
    return { leadId: lead.id, fu: fu as { id: string; scheduled_for: string } }
  }
  const postDrafted = (fuId: string, payload: Record<string, unknown>, eventId = randomUUID()) =>
    fetch(`${APP}/api/automation/followup-drafted`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-flowlead-secret': env.AUTOMATION_SHARED_SECRET },
      body: JSON.stringify({ event_id: eventId, event_type: 'followup.drafted', organization_id: orgId, subject_id: fuId, payload }),
    })

  it('a "send" draft becomes an Approval Inbox card and an outreach draft, and nothing is sent', async () => {
    const { fu } = await pendingFollowUp()
    const eventId = randomUUID()
    const res = await postDrafted(fu.id, { decision: 'send', reason: 'Warm enquiry, 3 days quiet', subject: 'Quick follow-up', body: 'Hi Dana,\nOne idea for Draft Co.' }, eventId)
    expect(await res.json()).toMatchObject({ ok: true, outcome: 'awaiting_approval' })

    const { data: appr } = await db.from('approvals').select('status, tier, action_type, payload_json').eq('organization_id', orgId).eq('action_type', 'send_follow_up_email').single()
    expect(appr).toMatchObject({ status: 'pending', tier: 'review' })
    expect((appr!.payload_json as { subject: string }).subject).toBe('Quick follow-up')
    const { data: msg } = await db.from('outreach_messages').select('status, sent_at, follow_up_id').eq('follow_up_id', fu.id).single()
    expect(msg).toMatchObject({ status: 'draft', sent_at: null })

    // Same delivery again is a no-op: still exactly one approval.
    expect(await (await postDrafted(fu.id, { decision: 'send', reason: 'x', subject: 's', body: 'b' }, eventId)).json()).toMatchObject({ duplicate: true })
    const { count } = await db.from('approvals').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).eq('action_type', 'send_follow_up_email')
    expect(count).toBe(1)
  })

  it('"delay" can only move a step later, capped at 7 days', async () => {
    const { fu } = await pendingFollowUp()
    const planned = new Date(fu.scheduled_for).getTime()

    const earlier = await postDrafted(fu.id, { decision: 'delay', reason: 'try sooner', delay_until: new Date(planned - 60 * 60_000).toISOString() })
    expect(await earlier.json()).toMatchObject({ outcome: 'delay_refused' })

    const far = await postDrafted(fu.id, { decision: 'delay', reason: 'they are away', delay_until: new Date(planned + 30 * 24 * 60 * 60_000).toISOString() })
    expect(await far.json()).toMatchObject({ outcome: 'delayed' })
    const { data: after } = await db.from('follow_ups').select('scheduled_for, decided_by').eq('id', fu.id).single()
    expect(new Date(after!.scheduled_for).getTime()).toBe(planned + 7 * 24 * 60 * 60_000)
    expect(after!.decided_by).toBe('ai')
  })

  it('"skip" closes the step with the AI reason', async () => {
    const { fu } = await pendingFollowUp()
    await postDrafted(fu.id, { decision: 'skip', reason: 'Lead said they chose another agency' })
    const { data: after } = await db.from('follow_ups').select('status, decided_by, reason').eq('id', fu.id).single()
    expect(after).toMatchObject({ status: 'skipped', decided_by: 'ai' })
    expect(after!.reason).toContain('another agency')
  })

  it('a draft for a do-not-contact lead is blocked by the database, not sent to the inbox', async () => {
    const { leadId, fu } = await pendingFollowUp()
    await db.from('leads').update({ do_not_contact: true }).eq('id', leadId)
    const res = await postDrafted(fu.id, { decision: 'send', reason: 'x', subject: 's', body: 'b' })
    const json = await res.json()
    // DNC skips pending follow-ups (kill switch), so the step is either ignored or blocked.
    expect(['ignored', 'blocked']).toContain(json.outcome)
    const { count } = await db.from('outreach_messages').select('id', { count: 'exact', head: true }).eq('lead_id', leadId)
    expect(count).toBe(0)
  })

  // ---- approve -> queue -> send (up to the Gmail call) ---------------------------
  const WEDNESDAY_10AM = new Date('2026-01-14T10:00:00Z')
  const approvedDraft = async (decision: 'approved' | 'rejected') => {
    const { leadId, fu } = await pendingFollowUp()
    await db.from('follow_ups').update({ scheduled_for: '2026-01-14T09:30:00Z' }).eq('id', fu.id)
    await postDrafted(fu.id, { decision: 'send', reason: 'r', subject: 'Hello', body: 'Hi' })
    const { data: appr } = await db.from('approvals').select('id').eq('organization_id', orgId).eq('subject_id', leadId).single()
    await db.from('approvals').update({ status: decision, decided_at: new Date().toISOString() }).eq('id', appr!.id) // what decide_approval does
    if (decision === 'approved') await queueApprovedFollowUp(db, appr!.id)
    else await closeRejectedFollowUp(db, appr!.id)
    return { leadId, fuId: fu.id }
  }

  it('approving queues the email; with no mailbox connected it waits instead of failing', async () => {
    const { leadId } = await approvedDraft('approved')
    const { data: msg } = await db.from('outreach_messages').select('status').eq('lead_id', leadId).single()
    expect(msg!.status).toBe('queued')
    const res = await sendDueFollowUps(db, WEDNESDAY_10AM)
    expect(res.waiting_for_mailbox).toBeGreaterThanOrEqual(1)
    const { data: still } = await db.from('outreach_messages').select('status').eq('lead_id', leadId).single()
    expect(still!.status).toBe('queued')
  })

  it('nothing is sent outside UK business hours', async () => {
    expect((await sendDueFollowUps(db, new Date('2026-01-17T10:00:00Z'))).outside_window).toBe(true) // Saturday
  })

  it('rejecting closes the step so the sequence stops', async () => {
    const { fuId } = await approvedDraft('rejected')
    const { data: fu } = await db.from('follow_ups').select('status, decided_by').eq('id', fuId).single()
    expect(fu).toMatchObject({ status: 'skipped', decided_by: 'human' })
  })

  it('a lead marked do-not-contact after approval is never sent to', async () => {
    const { leadId } = await approvedDraft('approved')
    await db.from('mail_connections').insert({ organization_id: orgId, profile_id: (await db.from('profiles').select('id').eq('user_id', userId).single()).data!.id, email: 'me@test.dev', access_token: 'fake', token_expires_at: new Date(Date.now() + 3600_000).toISOString() })
    await db.from('leads').update({ do_not_contact: true }).eq('id', leadId)
    await sendDueFollowUps(db, WEDNESDAY_10AM)
    const { data: msg } = await db.from('outreach_messages').select('status, sent_at, gmail_message_id').eq('lead_id', leadId).single()
    expect(msg!.status).toBe('failed') // blocked before Gmail was ever called
    expect(msg!.gmail_message_id).toBeNull()
    await db.from('mail_connections').delete().eq('organization_id', orgId)
  })

  // ---- replies ------------------------------------------------------------------
  const sentThread = async () => {
    const { leadId, fu } = await pendingFollowUp()
    const threadId = `th-${randomUUID()}`
    await db.from('outreach_messages').insert({ organization_id: orgId, lead_id: leadId, channel: 'email', status: 'sent', source: 'user', body: 'Hi', subject: 'Hello', sent_at: new Date().toISOString(), gmail_message_id: `gm-${randomUUID()}`, gmail_thread_id: threadId })
    return { leadId, fuId: fu.id, threadId }
  }
  const reply = (threadId: string, extra: Partial<{ snippet: string; subject: string; autoSubmitted: string }> = {}) => ({
    gmailMessageId: `in-${randomUUID()}`, threadId, from: 'Dana <dana@draftco.test>', subject: 'Re: Hello', snippet: 'Sounds good, Thursday?', autoSubmitted: null, ...extra,
  })

  it('a real reply stops the sequence and creates an urgent task, once', async () => {
    const { leadId, fuId, threadId } = await sentThread()
    const r = reply(threadId)
    expect(await applyReply(db, { organization_id: orgId }, r)).toBe('applied')
    expect(await applyReply(db, { organization_id: orgId }, r)).toBe('duplicate')

    const { data: fu } = await db.from('follow_ups').select('status, reason').eq('id', fuId).single()
    expect(fu).toMatchObject({ status: 'skipped', reason: 'Lead replied' })
    const { data: tasks } = await db.from('tasks').select('priority, title').eq('lead_id', leadId)
    expect(tasks).toHaveLength(1)
    expect(tasks![0].priority).toBe('high')
  })

  it('"stop" turns on do-not-contact', async () => {
    const { leadId, threadId } = await sentThread()
    await applyReply(db, { organization_id: orgId }, reply(threadId, { snippet: 'Please stop emailing me' }))
    const { data: lead } = await db.from('leads').select('do_not_contact').eq('id', leadId).single()
    expect(lead!.do_not_contact).toBe(true)
  })

  it('an out-of-office pushes the next step back instead of ending the sequence', async () => {
    const { fuId, threadId } = await sentThread()
    const { data: before } = await db.from('follow_ups').select('scheduled_for').eq('id', fuId).single()
    await applyReply(db, { organization_id: orgId }, reply(threadId, { subject: 'Automatic reply: Hello', snippet: 'I am away' }))
    const { data: after } = await db.from('follow_ups').select('status, scheduled_for').eq('id', fuId).single()
    expect(after!.status).toBe('pending')
    expect(new Date(after!.scheduled_for).getTime()).toBeGreaterThan(new Date(before!.scheduled_for).getTime())
  })

  it('mail in threads FlowLead did not start is ignored', async () => {
    expect(await applyReply(db, { organization_id: orgId }, reply(`th-unknown-${randomUUID()}`))).toBe('not_ours')
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
