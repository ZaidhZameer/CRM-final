import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AUTOMATION_SECRET_HEADER } from './secret'
import type { FollowUpDraftRequested } from './contract'
import { getAiBudget, budgetMessage } from '@/lib/ai-budget'
import { MAX_AUTOMATED_STEPS } from '@/lib/follow-ups'

// Asks the engine (n8n followup-drafter) to draft automated follow-ups that are due soon.
// Called by the lifecycle cron. Drafting a day ahead gives the owner time to approve before
// the scheduled send time. Spec: Obsidian SALES-OS/INTERNAL/FLOWLEAD_FOLLOWUPS_SPEC_2026-09-24.md

export const DRAFT_JOB_TYPE = 'followup.draft'
const DRAFT_AHEAD_MS = 24 * 60 * 60_000
const MAX_DELAY_MS = 7 * 24 * 60 * 60_000 // the furthest the AI may push a step
const MAX_PER_RUN = 10
const TIMEOUT_MS = 8000

type DueFollowUp = { id: string; organization_id: string; lead_id: string; step: number; scheduled_for: string }

/** Builds the draft request for one follow-up, or null when there is no one to email. */
export async function buildDraftRequest(service: SupabaseClient, f: DueFollowUp): Promise<FollowUpDraftRequested | null> {
  const { data: lead } = await service
    .from('leads')
    .select('id, booking_answers_json, companies(name), contacts(full_name, email, job_title)')
    .eq('id', f.lead_id)
    .eq('organization_id', f.organization_id)
    .single()
  const contact = (lead?.contacts ?? null) as unknown as { full_name: string | null; email: string | null; job_title: string | null } | null
  const company = (lead?.companies ?? null) as unknown as { name: string | null } | null
  if (!lead || !contact?.email) return null

  const [{ data: report }, { data: submission }, { data: messages }, { data: org }, { data: owner }] = await Promise.all([
    service
      .from('research_reports')
      .select('company_summary, pain_points_json, recommended_offer, outreach_angle, next_best_action')
      .eq('lead_id', f.lead_id)
      .eq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    service
      .from('lead_form_submissions')
      .select('data_json')
      .eq('converted_lead_id', f.lead_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    service
      .from('outreach_messages')
      .select('status, subject, body, sent_at, replied_at, created_at')
      .eq('lead_id', f.lead_id)
      .in('status', ['sent', 'replied'])
      .order('created_at', { ascending: true })
      .limit(20),
    service.from('organizations').select('name').eq('id', f.organization_id).single(),
    service
      .from('memberships')
      .select('profiles(full_name)')
      .eq('organization_id', f.organization_id)
      .eq('role', 'owner')
      .eq('status', 'active')
      .limit(1)
      .maybeSingle(),
  ])

  const booking = (lead.booking_answers_json ?? null) as { notes?: string | null } | null
  const form = (submission?.data_json ?? null) as Record<string, string> | null
  const enquiry = form?.message ?? form?.notes ?? booking?.notes ?? null
  const pain = report?.pain_points_json as unknown

  const scheduled = new Date(f.scheduled_for)
  return {
    event_id: randomUUID(),
    event_type: 'followup.draft.requested',
    organization_id: f.organization_id,
    subject_id: f.id,
    payload: {
      lead_id: f.lead_id,
      step: f.step,
      max_steps: MAX_AUTOMATED_STEPS,
      scheduled_for: scheduled.toISOString(),
      latest_allowed: new Date(scheduled.getTime() + MAX_DELAY_MS).toISOString(),
      contact: {
        full_name: contact.full_name,
        email: contact.email,
        company_name: company?.name ?? null,
        job_title: contact.job_title,
      },
      research: report
        ? {
            company_summary: report.company_summary,
            pain_points: Array.isArray(pain) ? (pain as unknown[]).map(String).slice(0, 50) : null,
            recommended_offer: report.recommended_offer,
            outreach_angle: report.outreach_angle,
            next_best_action: report.next_best_action,
          }
        : null,
      enquiry: enquiry ? String(enquiry).slice(0, 5000) : null,
      history: (messages ?? []).map((m) => ({
        direction: 'outbound' as const,
        subject: m.subject,
        body: String(m.body ?? '').slice(0, 10000),
        at: m.sent_at ?? m.created_at,
      })),
      sender: {
        name: ((owner?.profiles ?? null) as unknown as { full_name: string | null } | null)?.full_name ?? null,
        company: org?.name ?? null,
      },
      // Unprompted touches never carry a booking link (spec decision 3).
      rules: { booking_link_allowed: false, max_words: 120 },
    },
  }
}

/** Requests drafts for automated follow-ups due within a day. Returns how many were sent. */
export async function requestDueFollowUpDrafts(service: SupabaseClient): Promise<{ requested: number; skipped: string[] }> {
  const url = process.env.N8N_FOLLOWUP_DRAFT_URL
  const secret = process.env.AUTOMATION_SHARED_SECRET
  const skipped: string[] = []
  if (!url || !secret) return { requested: 0, skipped: ['N8N_FOLLOWUP_DRAFT_URL or AUTOMATION_SHARED_SECRET not set'] }

  const { data: due } = await service
    .from('follow_ups')
    .select('id, organization_id, lead_id, step, scheduled_for')
    .eq('status', 'pending')
    .eq('source', 'automation')
    .is('outreach_message_id', null)
    .lte('scheduled_for', new Date(Date.now() + DRAFT_AHEAD_MS).toISOString())
    .order('scheduled_for', { ascending: true })
    .limit(MAX_PER_RUN * 3)

  let requested = 0
  for (const f of (due ?? []) as DueFollowUp[]) {
    if (requested >= MAX_PER_RUN) break

    // One draft in flight per follow-up.
    const { count: open } = await service
      .from('jobs')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', f.organization_id)
      .eq('job_type', DRAFT_JOB_TYPE)
      .eq('subject_id', f.id)
      .in('status', ['queued', 'running', 'awaiting_approval'])
    if (open) continue

    // Back off for an hour after a failed attempt, so an engine outage isn't retried every run.
    const { count: recentFail } = await service
      .from('jobs')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', f.organization_id)
      .eq('job_type', DRAFT_JOB_TYPE)
      .eq('subject_id', f.id)
      .eq('status', 'failed')
      .gte('finished_at', new Date(Date.now() - 60 * 60_000).toISOString())
    if (recentFail) continue

    const budget = await getAiBudget(service, f.organization_id)
    if (budget.exhausted) {
      skipped.push(`${f.id}: ${budgetMessage(budget)}`)
      continue
    }

    const event = await buildDraftRequest(service, f)
    if (!event) {
      // No email address: nothing can ever be sent, so close the step instead of retrying forever.
      await service.from('follow_ups').update({ status: 'skipped', reason: 'No email address on the lead' }).eq('id', f.id)
      skipped.push(`${f.id}: no email`)
      continue
    }

    const jobKey = { event_id: event.event_id, organization_id: f.organization_id }
    await service.from('jobs').insert({ ...jobKey, job_type: DRAFT_JOB_TYPE, subject_type: 'follow_up', subject_id: f.id, status: 'queued' })
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [AUTOMATION_SECRET_HEADER]: secret },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: 'no-store',
      })
      if (res.ok) {
        await service.from('jobs').update({ status: 'running', started_at: new Date().toISOString(), attempts: 1 }).match(jobKey)
        requested++
      } else {
        await service.from('jobs').update({ status: 'failed', finished_at: new Date().toISOString(), error_message: `engine rejected draft request (HTTP ${res.status})` }).match(jobKey)
      }
    } catch (err) {
      await service.from('jobs').update({ status: 'failed', finished_at: new Date().toISOString(), error_message: `could not reach engine: ${err instanceof Error ? err.message : 'unknown'}` }).match(jobKey)
    }
  }
  return { requested, skipped }
}
