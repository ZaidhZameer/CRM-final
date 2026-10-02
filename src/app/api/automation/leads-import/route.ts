import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { verifyAutomationSecret } from '@/lib/automation/secret'
import { leadsImportSchema } from '@/lib/automation/contract'
import { importLeads } from '@/lib/sourcing/import'

// POST /api/automation/leads-import   (header: x-flowlead-secret)
// The official door for leads from any source. Idempotent per event_id: a retried delivery
// returns the stored outcome and creates nothing twice. See src/lib/sourcing/import.ts for the rules.

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
  const parsed = leadsImportSchema.safeParse(raw)
  if (!parsed.success) return fail(422, 'invalid_payload', { issues: parsed.error.issues.slice(0, 5) })
  const body = parsed.data
  const service = createServiceClient()

  const { data: org } = await service.from('organizations').select('id').eq('id', body.organization_id).maybeSingle()
  if (!org) return fail(404, 'unknown_organization')

  const { error: claim } = await service.from('automation_events').insert({
    event_id: body.event_id, organization_id: body.organization_id, direction: 'inbound', event_type: body.event_type, status: 'processing',
  })
  if (claim) {
    if (claim.code !== '23505') return fail(500, 'internal_error')
    const { data: prior } = await service.from('automation_events').select('status, result_json').eq('event_id', body.event_id).eq('organization_id', body.organization_id).maybeSingle()
    return prior?.status === 'completed'
      ? NextResponse.json({ ok: true, duplicate: true, results: (prior.result_json as { results?: unknown } | null)?.results ?? [] })
      : fail(409, 'conflict')
  }

  try {
    const results = await importLeads(service, body.organization_id, body.payload.source, body.payload.leads)
    await service.from('automation_events').update({ status: 'completed', result_json: { results } }).eq('event_id', body.event_id)
    const created = results.filter((r) => r.status === 'created').length
    return NextResponse.json({ ok: true, created, duplicates: results.filter((r) => r.status === 'duplicate').length, rejected: results.filter((r) => r.status === 'rejected').length, results })
  } catch (err) {
    console.error('[leads-import] failed', body.event_id, err instanceof Error ? err.message : err)
    await service.from('automation_events').update({ status: 'failed', error_message: 'unhandled error' }).eq('event_id', body.event_id)
    return fail(500, 'internal_error')
  }
}
