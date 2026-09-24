import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { verifyAutomationSecret } from '@/lib/automation/secret'
import { followUpDraftedSchema } from '@/lib/automation/contract'

// POST /api/automation/followup-drafted   (header: x-flowlead-secret)
// The engine's answer to followup.draft.requested. FlowLead, not the model, enforces the bounds:
//   send  -> outreach draft + Approval Inbox card (review tier); nothing is sent until approved
//   delay -> reschedule, but only later than planned and never past latest_allowed (7 days)
//   skip  -> close the step with the model's reason
// Spec: Obsidian SALES-OS/INTERNAL/FLOWLEAD_FOLLOWUPS_SPEC_2026-09-24.md

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_DELAY_MS = 7 * 24 * 60 * 60_000
const APPROVAL_TTL_MS = 3 * 24 * 60 * 60_000

const fail = (status: number, error: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ ok: false, error, ...extra }, { status })

export async function POST(request: NextRequest) {
  if (!verifyAutomationSecret(request).ok) return fail(401, 'unauthorized')

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return fail(400, 'invalid_json')
  }
  const parsed = followUpDraftedSchema.safeParse(raw)
  if (!parsed.success) return fail(422, 'invalid_payload', { issues: parsed.error.issues.slice(0, 5) })
  const body = parsed.data
  const p = body.payload
  const service = createServiceClient()

  const closeJob = async (patch: Record<string, unknown>) => {
    if (!body.correlation_id) return
    await service
      .from('jobs')
      .update({ finished_at: new Date().toISOString(), ...patch })
      .eq('event_id', body.correlation_id)
      .eq('organization_id', body.organization_id)
  }

  // Idempotency: first delivery claims the event; a repeat of a completed one is a no-op.
  const { error: claimError } = await service.from('automation_events').insert({
    event_id: body.event_id,
    organization_id: body.organization_id,
    direction: 'inbound',
    event_type: body.event_type,
    status: 'processing',
  })
  if (claimError) {
    if (claimError.code !== '23505') return fail(500, 'internal_error')
    const { data: prior } = await service
      .from('automation_events')
      .select('status')
      .eq('event_id', body.event_id)
      .eq('organization_id', body.organization_id)
      .maybeSingle()
    return prior?.status === 'completed'
      ? NextResponse.json({ ok: true, duplicate: true })
      : fail(409, 'conflict')
  }
  const finish = (status: 'completed' | 'failed', result: Record<string, unknown>) =>
    service.from('automation_events').update({ status, result_json: result }).eq('event_id', body.event_id)

  const { data: fu } = await service
    .from('follow_ups')
    .select('id, organization_id, lead_id, step, status, scheduled_for, outreach_message_id')
    .eq('id', body.subject_id)
    .eq('organization_id', body.organization_id)
    .maybeSingle()

  if (!fu || fu.status !== 'pending' || fu.outreach_message_id) {
    // The step was completed, skipped or cancelled (e.g. the lead replied) while drafting.
    const reason = !fu ? 'follow_up_not_found' : 'follow_up_no_longer_pending'
    await finish('completed', { outcome: 'ignored', reason })
    await closeJob({ status: 'cancelled', error_message: reason })
    return NextResponse.json({ ok: true, outcome: 'ignored', reason })
  }

  // Cost ledger, best effort.
  if (p.usage?.length) {
    await service.from('ai_usage_log').insert(
      p.usage.map((u) => ({
        organization_id: fu.organization_id,
        lead_id: fu.lead_id,
        model: u.model,
        tier: 'basic',
        prompt_tokens: u.prompt_tokens ?? 0,
        completion_tokens: u.completion_tokens ?? 0,
        cost_usd_cents: Math.round((u.cost_usd ?? 0) * 100 * 10000) / 10000,
        latency_ms: u.latency_ms ?? null,
        status: 'success',
      }))
    )
  }

  if (p.decision === 'skip') {
    await service.from('follow_ups').update({ status: 'skipped', decided_by: 'ai', reason: `AI skipped: ${p.reason}` }).eq('id', fu.id)
    await finish('completed', { outcome: 'skipped' })
    await closeJob({ status: 'done', result_json: { decision: 'skip', reason: p.reason } })
    return NextResponse.json({ ok: true, outcome: 'skipped' })
  }

  if (p.decision === 'delay') {
    const planned = new Date(fu.scheduled_for).getTime()
    const asked = new Date(p.delay_until!).getTime()
    if (!Number.isFinite(asked) || asked <= planned) {
      // "Delay" to an earlier or invalid time would bring the step forward: refuse, keep the plan.
      await finish('completed', { outcome: 'delay_refused' })
      await closeJob({ status: 'failed', error_message: 'engine proposed a delay that was not later than planned' })
      return NextResponse.json({ ok: true, outcome: 'delay_refused' })
    }
    const until = new Date(Math.min(asked, planned + MAX_DELAY_MS)).toISOString()
    await service.from('follow_ups').update({ scheduled_for: until, decided_by: 'ai', reason: `AI delayed: ${p.reason}` }).eq('id', fu.id)
    await finish('completed', { outcome: 'delayed', until })
    await closeJob({ status: 'done', result_json: { decision: 'delay', until, reason: p.reason } })
    return NextResponse.json({ ok: true, outcome: 'delayed', until })
  }

  // decision === 'send': draft + approval card. Nothing leaves until a human approves.
  const { data: lead } = await service
    .from('leads')
    .select('id, companies(name), contacts(full_name, email)')
    .eq('id', fu.lead_id)
    .single()
  const contact = (lead?.contacts ?? null) as unknown as { full_name: string | null; email: string | null } | null
  const company = (lead?.companies ?? null) as unknown as { name: string | null } | null
  if (!contact?.email) {
    await service.from('follow_ups').update({ status: 'skipped', reason: 'No email address on the lead' }).eq('id', fu.id)
    await finish('completed', { outcome: 'no_email' })
    await closeJob({ status: 'failed', error_message: 'lead has no email address' })
    return NextResponse.json({ ok: true, outcome: 'no_email' })
  }

  // The automation-draft interlock re-checks do-not-contact, closed lead, meeting and PECR here.
  const { data: message, error: msgError } = await service
    .from('outreach_messages')
    .insert({
      organization_id: fu.organization_id,
      lead_id: fu.lead_id,
      channel: 'email',
      status: 'draft',
      source: 'automation',
      to_email: contact.email,
      subject: p.subject,
      body: p.body,
      follow_up_id: fu.id,
    })
    .select('id')
    .single()

  if (msgError || !message) {
    const blocked = msgError?.code === 'P0001'
    if (blocked) {
      await service.from('follow_ups').update({ status: 'skipped', reason: msgError!.message }).eq('id', fu.id)
    }
    await finish(blocked ? 'completed' : 'failed', { outcome: blocked ? 'blocked' : 'error', reason: msgError?.message })
    await closeJob({ status: blocked ? 'cancelled' : 'failed', error_message: msgError?.message ?? 'draft insert failed' })
    return blocked ? NextResponse.json({ ok: true, outcome: 'blocked', reason: msgError!.message }) : fail(500, 'internal_error')
  }

  const who = [contact.full_name, company?.name].filter(Boolean).join(', ') || contact.email
  const { data: approval, error: apprError } = await service
    .from('approvals')
    .insert({
      organization_id: fu.organization_id,
      job_id: null,
      action_type: 'send_follow_up_email',
      tier: 'review',
      subject_type: 'lead',
      subject_id: fu.lead_id,
      title: `Follow-up ${fu.step} to ${who}`,
      summary: p.reason,
      payload_json: { to: contact.email, subject: p.subject, body: p.body, outreach_message_id: message.id, follow_up_id: fu.id },
      expires_at: new Date(Math.max(Date.now(), new Date(fu.scheduled_for).getTime()) + APPROVAL_TTL_MS).toISOString(),
    })
    .select('id')
    .single()

  if (apprError || !approval) {
    await service.from('outreach_messages').delete().eq('id', message.id)
    await finish('failed', { outcome: 'error', reason: apprError?.message })
    await closeJob({ status: 'failed', error_message: apprError?.message ?? 'approval insert failed' })
    return fail(500, 'internal_error')
  }

  await service.from('outreach_messages').update({ approval_id: approval.id }).eq('id', message.id)
  await service.from('follow_ups').update({ outreach_message_id: message.id }).eq('id', fu.id)

  // Link the drafting job to the approval so an approve/reject decision moves it on.
  if (body.correlation_id) {
    const { data: job } = await service
      .from('jobs')
      .update({ status: 'awaiting_approval' })
      .eq('event_id', body.correlation_id)
      .eq('organization_id', body.organization_id)
      .select('id')
      .maybeSingle()
    if (job) await service.from('approvals').update({ job_id: job.id }).eq('id', approval.id)
  }

  await finish('completed', { outcome: 'awaiting_approval', approval_id: approval.id })
  return NextResponse.json({ ok: true, outcome: 'awaiting_approval', approval_id: approval.id })
}
