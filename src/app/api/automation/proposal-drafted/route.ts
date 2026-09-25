import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { verifyAutomationSecret } from '@/lib/automation/secret'
import { proposalDraftedSchema } from '@/lib/automation/contract'
import { sanitizeSections } from '@/lib/proposals'

// POST /api/automation/proposal-drafted   (header: x-flowlead-secret)
// The engine's draft of a proposal. FlowLead strips any money amounts (pricing is human-only),
// stores the sections on the draft and raises an always-human approval card that points to the
// editor, where the price is set. Spec: Obsidian SALES-OS/INTERNAL/FLOWLEAD_PROPOSALS_SPEC_2026-09-25.md

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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
  const parsed = proposalDraftedSchema.safeParse(raw)
  if (!parsed.success) return fail(422, 'invalid_payload', { issues: parsed.error.issues.slice(0, 5) })
  const body = parsed.data
  const service = createServiceClient()

  const { error: claimError } = await service.from('automation_events').insert({
    event_id: body.event_id,
    organization_id: body.organization_id,
    direction: 'inbound',
    event_type: body.event_type,
    status: 'processing',
  })
  if (claimError) {
    if (claimError.code !== '23505') return fail(500, 'internal_error')
    const { data: prior } = await service.from('automation_events').select('status').eq('event_id', body.event_id).eq('organization_id', body.organization_id).maybeSingle()
    return prior?.status === 'completed' ? NextResponse.json({ ok: true, duplicate: true }) : fail(409, 'conflict')
  }
  const finish = (result: Record<string, unknown>) =>
    service.from('automation_events').update({ status: 'completed', result_json: result }).eq('event_id', body.event_id)
  const closeJob = (patch: Record<string, unknown>) =>
    body.correlation_id
      ? service.from('jobs').update({ finished_at: new Date().toISOString(), ...patch }).eq('event_id', body.correlation_id).eq('organization_id', body.organization_id)
      : Promise.resolve()

  const { data: proposal } = await service
    .from('proposals')
    .select('id, organization_id, lead_id, status, approval_id')
    .eq('id', body.subject_id)
    .eq('organization_id', body.organization_id)
    .is('deleted_at', null)
    .maybeSingle()

  if (!proposal || proposal.status !== 'draft') {
    // Withdrawn, or already moved on by a human while the AI was writing: don't overwrite.
    await finish({ outcome: 'ignored' })
    await closeJob({ status: 'cancelled', error_message: 'proposal no longer a draft' })
    return NextResponse.json({ ok: true, outcome: 'ignored' })
  }

  if (body.payload.usage?.length) {
    await service.from('ai_usage_log').insert(
      body.payload.usage.map((u) => ({
        organization_id: proposal.organization_id,
        lead_id: proposal.lead_id,
        model: u.model,
        tier: 'standard',
        prompt_tokens: u.prompt_tokens ?? 0,
        completion_tokens: u.completion_tokens ?? 0,
        cost_usd_cents: Math.round((u.cost_usd ?? 0) * 100 * 10000) / 10000,
        latency_ms: u.latency_ms ?? null,
        status: 'success',
      }))
    )
  }

  const sections = sanitizeSections(body.payload.sections)
  await service
    .from('proposals')
    .update({ title: body.payload.title.replace(/[\r\n]+/g, ' ').slice(0, 200), content_json: { sections, drafted_by: 'ai', drafted_at: new Date().toISOString() } })
    .eq('id', proposal.id)

  let approvalId = proposal.approval_id
  if (!approvalId) {
    const { data: approval } = await service
      .from('approvals')
      .insert({
        organization_id: proposal.organization_id,
        action_type: 'send_proposal',
        tier: 'always_human',
        subject_type: 'lead',
        subject_id: proposal.lead_id,
        title: body.payload.title.slice(0, 200),
        summary: 'AI draft ready. Open it, check every section and set the price before approving.',
        payload_json: { proposal_id: proposal.id, editor_url: `/proposals/${proposal.id}` },
      })
      .select('id')
      .single()
    approvalId = approval?.id ?? null
    if (approvalId) await service.from('proposals').update({ approval_id: approvalId }).eq('id', proposal.id)
  }

  if (body.correlation_id) {
    const { data: job } = await service
      .from('jobs')
      .update({ status: 'awaiting_approval' })
      .eq('event_id', body.correlation_id)
      .eq('organization_id', body.organization_id)
      .select('id')
      .maybeSingle()
    if (job && approvalId) await service.from('approvals').update({ job_id: job.id }).eq('id', approvalId)
  }

  await finish({ outcome: 'drafted', approval_id: approvalId })
  return NextResponse.json({ ok: true, outcome: 'drafted', proposal_id: proposal.id, approval_id: approvalId })
}
