import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { verifyCronSecret } from '@/lib/automation/secret'
import { requestDueFollowUpDrafts } from '@/lib/automation/follow-up-drafts'
import { sendDueFollowUps } from '@/lib/follow-up-sender'

// Called every 15 minutes by the n8n lifecycle scheduler.
// GET /api/cron/lifecycle   (header: x-cron-secret)
//   1. Jobs the engine never answered are closed as failed, so nothing sits "running" forever.
//   2. Meetings that ended but were never given an outcome get one reminder task for the rep.
//   3. Automated follow-ups due within a day are sent to the engine for drafting.
//   4. Approved follow-ups are sent from the connected mailbox at their scheduled time.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const JOB_TIMEOUT_MINUTES = 30
const OUTCOME_GRACE_MINUTES = 60
const OUTCOME_LOOKBACK_DAYS = 7

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request).ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const service = createServiceClient()

  // ---- 1. Stale jobs ----------------------------------------------------------
  const cutoff = minutesAgo(JOB_TIMEOUT_MINUTES)
  const { data: staleJobs, error: jobsError } = await service
    .from('jobs')
    .update({
      status: 'failed',
      finished_at: new Date().toISOString(),
      error_message: `no result from the engine within ${JOB_TIMEOUT_MINUTES} minutes`,
    })
    // Jobs age from when they entered their current state: queued_at for queued (a job can
    // wait in awaiting_approval first), started_at for running.
    .or(
      `and(status.eq.queued,queued_at.lt.${cutoff}),` +
        `and(status.eq.queued,queued_at.is.null,created_at.lt.${cutoff}),` +
        `and(status.eq.running,started_at.lt.${cutoff}),` +
        `and(status.eq.running,started_at.is.null,created_at.lt.${cutoff})`
    )
    .select('id')

  if (jobsError) console.error('[cron/lifecycle] stale job sweep failed', jobsError.message)

  // ---- 2. Meeting outcome prompts ---------------------------------------------
  const { data: meetings, error: meetingsError } = await service
    .from('meetings')
    .select('id, organization_id, lead_id, title, end_time, created_by')
    .eq('status', 'scheduled')
    .lt('end_time', minutesAgo(OUTCOME_GRACE_MINUTES))
    .gt('end_time', minutesAgo(OUTCOME_LOOKBACK_DAYS * 24 * 60))
    .limit(200)

  if (meetingsError) console.error('[cron/lifecycle] meeting lookup failed', meetingsError.message)

  let promptsCreated = 0
  for (const m of meetings ?? []) {
    const title = `Log meeting outcome: ${m.title}`.slice(0, 200)

    // One prompt per meeting: skip if an open or finished prompt already exists.
    let existing = service
      .from('tasks')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', m.organization_id)
      .eq('title', title)
      .gte('created_at', m.end_time)
    // .eq() never matches NULL, so meetings without a lead need .is() or the dedupe fails open.
    existing = m.lead_id ? existing.eq('lead_id', m.lead_id) : existing.is('lead_id', null)
    const { count } = await existing

    if (count && count > 0) continue

    const { error } = await service.from('tasks').insert({
      organization_id: m.organization_id,
      lead_id: m.lead_id,
      title,
      description:
        'This meeting has ended but is still marked as scheduled. Mark it completed or no-show so follow-ups can resume.',
      priority: 'medium',
      status: 'todo',
      due_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      assigned_to: m.created_by ?? null,
    })

    if (error) console.error('[cron/lifecycle] outcome prompt insert failed', m.id, error.message)
    else promptsCreated++
  }

  // ---- 3. Follow-up drafts due within a day ------------------------------------
  const drafts = await requestDueFollowUpDrafts(service).catch((err) => {
    console.error('[cron/lifecycle] follow-up drafting failed', err instanceof Error ? err.message : err)
    return { requested: 0, skipped: ['error'] }
  })

  // ---- 4. Send approved follow-ups whose time has come ---------------------------
  const sending = await sendDueFollowUps(service).catch((err) => {
    console.error('[cron/lifecycle] follow-up sending failed', err instanceof Error ? err.message : err)
    return null
  })

  return NextResponse.json({
    ok: !jobsError && !meetingsError,
    follow_ups_sending: sending,
    follow_up_drafts_requested: drafts.requested,
    follow_up_drafts_skipped: drafts.skipped.length,
    stale_jobs_closed: staleJobs?.length ?? 0,
    meetings_checked: meetings?.length ?? 0,
    outcome_prompts_created: promptsCreated,
  })
}
