import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod/v4'
import { createServiceClient } from '@/lib/supabase/service'
import { verifyAutomationSecret } from '@/lib/automation/secret'

// Inbound webhook: receives lead-enrichment results from the n8n adapter.
// POST /api/automation/result
//   Auth:  x-flowlead-secret header, compared timing-safely, FAILS CLOSED.
//   Idempotency: event_id is claimed in public.automation_events (PK) before any write.
//   Writes: one row in research_reports + a narrow, version-guarded update of leads.
//
// This route never blind-UPDATEs a lead. It refuses to overwrite a lead a human has
// already resolved (converted / lost / unqualified) and refuses on a version mismatch.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Statuses a human has already decided. Enrichment must never resurrect these.
const HUMAN_TERMINAL_STATUSES = ['converted', 'lost', 'unqualified'] as const

const payloadSchema = z.object({
  event_id: z.string().uuid(),
  event_type: z.literal('lead.enriched'),
  organization_id: z.string().uuid(),
  lead_id: z.string().uuid(),
  // Version the emitting side saw. When present it is enforced; when absent we use the
  // version we just read (still guarded — a concurrent writer will lose the update).
  expected_version: z.number().int().positive().optional(),
  research: z.object({
    tier: z.enum(['basic', 'standard', 'deep']).default('basic'),
    status: z.enum(['pending', 'running', 'completed', 'failed']).default('completed'),
    company_summary: z.string().max(20000).nullish(),
    website_analysis: z.string().max(20000).nullish(),
    pain_points: z.array(z.string().max(2000)).max(50).nullish(),
    recommended_offer: z.string().max(5000).nullish(),
    outreach_angle: z.string().max(5000).nullish(),
    objections: z.array(z.string().max(2000)).max(50).nullish(),
    next_best_action: z.string().max(5000).nullish(),
    lead_score: z.number().int().min(0).max(100).nullish(),
    confidence_score: z.number().min(0).max(1).nullish(),
    model: z.string().max(200).nullish(),
    error_message: z.string().max(2000).nullish(),
  }),
  lead_update: z
    .object({
      lead_score: z.number().int().min(0).max(100).optional(),
      lead_quality: z.enum(['hot', 'warm', 'cold']).optional(),
      ai_status: z.enum(['pending', 'running', 'completed', 'failed']).optional(),
    })
    .optional(),
})

type Outcome =
  | 'applied'
  | 'skipped_terminal_status'
  | 'skipped_version_conflict'
  | 'research_only'

function fail(status: number, error: string, extra?: Record<string, unknown>) {
  // Structured, deliberately generic. Internal details go to the server log, not the body.
  return NextResponse.json({ ok: false, error, ...extra }, { status })
}

export async function POST(request: NextRequest) {
  // ---- 1. Auth: header-based, timing-safe, fail closed -----------------------
  const auth = verifyAutomationSecret(request)
  if (!auth.ok) {
    if (auth.reason === 'not_configured') {
      console.error('[automation] /api/automation/result called but AUTOMATION_SHARED_SECRET is not set — rejecting')
      return fail(503, 'automation_disabled')
    }
    return fail(401, 'unauthorized')
  }

  // ---- 2. Parse + validate ---------------------------------------------------
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return fail(400, 'invalid_json')
  }

  const parsed = payloadSchema.safeParse(raw)
  if (!parsed.success) {
    return fail(400, 'invalid_payload', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    })
  }
  const body = parsed.data

  const service = createServiceClient()

  // ---- 3. Claim the event (idempotency) --------------------------------------
  // Insert-first: a duplicate delivery hits the primary key and is answered as a no-op.
  const { error: claimError } = await service.from('automation_events').insert({
    event_id: body.event_id,
    organization_id: body.organization_id,
    lead_id: body.lead_id,
    direction: 'inbound',
    event_type: body.event_type,
    status: 'processing',
  })

  if (claimError) {
    if (claimError.code === '23505') {
      // Already seen. Idempotent success — do NOT write anything a second time.
      return NextResponse.json({ ok: true, duplicate: true, event_id: body.event_id })
    }
    console.error('[automation] failed to claim event', body.event_id, claimError.message)
    return fail(500, 'internal_error')
  }

  const markFailed = async (reason: string) => {
    await service
      .from('automation_events')
      .update({ status: 'failed', error_message: reason })
      .eq('event_id', body.event_id)
  }

  try {
    // ---- 4. Resolve the lead, org-scoped and soft-delete aware ---------------
    // organization_id is part of the WHERE clause, not just trusted from the payload —
    // a wrong org_id here yields "not found", never another tenant's row.
    const { data: lead, error: leadError } = await service
      .from('leads')
      .select('id, organization_id, status, version, lead_score, lead_quality, ai_status')
      .eq('id', body.lead_id)
      .eq('organization_id', body.organization_id)
      .is('deleted_at', null)
      .maybeSingle()

    if (leadError) {
      console.error('[automation] lead lookup failed', body.event_id, leadError.message)
      await markFailed('lead_lookup_failed')
      return fail(500, 'internal_error')
    }

    if (!lead) {
      await markFailed('lead_not_found')
      return fail(404, 'lead_not_found')
    }

    // ---- 5. Write the research report ----------------------------------------
    // NOTE: the columns are `tier` and `status` (types public.research_tier /
    // public.research_status), not `research_tier` / `research_status`.
    const r = body.research
    const { data: report, error: reportError } = await service
      .from('research_reports')
      .insert({
        organization_id: lead.organization_id,
        lead_id: lead.id,
        company_summary: r.company_summary ?? null,
        website_analysis: r.website_analysis ?? null,
        pain_points_json: r.pain_points ?? null,
        recommended_offer: r.recommended_offer ?? null,
        outreach_angle: r.outreach_angle ?? null,
        objections_json: r.objections ?? null,
        next_best_action: r.next_best_action ?? null,
        lead_score: r.lead_score ?? null,
        confidence_score: r.confidence_score ?? null,
        model: r.model ?? null,
        tier: r.tier,
        status: r.status,
        error_message: r.error_message ?? null,
      })
      .select('id')
      .single()

    if (reportError || !report) {
      console.error('[automation] research_reports insert failed', body.event_id, reportError?.message)
      await markFailed('research_report_insert_failed')
      return fail(500, 'internal_error')
    }

    // ---- 6. Narrow guarded transition on the lead ----------------------------
    let outcome: Outcome = 'research_only'

    const wantsLeadUpdate =
      body.lead_update !== undefined || r.lead_score != null || r.status === 'failed'

    if (wantsLeadUpdate) {
      if ((HUMAN_TERMINAL_STATUSES as readonly string[]).includes(lead.status)) {
        // A human has already resolved this lead. Enrichment does not get to undo that.
        outcome = 'skipped_terminal_status'
      } else {
        const expectedVersion = body.expected_version ?? lead.version

        const patch: Record<string, unknown> = {
          ai_status:
            body.lead_update?.ai_status ?? (r.status === 'failed' ? 'failed' : 'completed'),
          version: expectedVersion + 1,
        }
        if (body.lead_update?.lead_score != null) patch.lead_score = body.lead_update.lead_score
        else if (r.lead_score != null) patch.lead_score = r.lead_score
        if (body.lead_update?.lead_quality) patch.lead_quality = body.lead_update.lead_quality

        const { data: updated, error: updateError } = await service
          .from('leads')
          .update(patch)
          .eq('id', lead.id)
          .eq('organization_id', body.organization_id)
          .is('deleted_at', null)
          .eq('version', expectedVersion)
          // Quoted form matches the idiom already used in src/app/api/cron/stale-leads.
          .not('status', 'in', `(${HUMAN_TERMINAL_STATUSES.map((s) => `"${s}"`).join(',')})`)
          .select('id, version')

        if (updateError) {
          console.error('[automation] lead update failed', body.event_id, updateError.message)
          await markFailed('lead_update_failed')
          return fail(500, 'internal_error')
        }

        outcome = updated && updated.length > 0 ? 'applied' : 'skipped_version_conflict'
      }
    }

    // ---- 7. Activity log + close the event -----------------------------------
    await service.from('activity_logs').insert({
      organization_id: lead.organization_id,
      action: 'researched',
      entity_type: 'lead',
      entity_id: lead.id,
      after_json: {
        source: 'n8n_automation',
        event_id: body.event_id,
        research_report_id: report.id,
        outcome,
      },
    })

    await service
      .from('automation_events')
      .update({
        status: 'completed',
        result_json: { outcome, research_report_id: report.id },
      })
      .eq('event_id', body.event_id)

    return NextResponse.json({
      ok: true,
      duplicate: false,
      event_id: body.event_id,
      lead_id: lead.id,
      research_report_id: report.id,
      outcome,
    })
  } catch (err) {
    console.error('[automation] unhandled error', body.event_id, err)
    await markFailed('unhandled_error')
    return fail(500, 'internal_error')
  }
}
