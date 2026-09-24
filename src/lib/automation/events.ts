import { randomUUID } from 'node:crypto'
import { after } from 'next/server'
import { AUTOMATION_SECRET_HEADER } from './secret'
import { createServiceClient } from '@/lib/supabase/service'
import type { LeadEnrichmentRequested } from './contract'
import { getAiBudget, budgetMessage } from '@/lib/ai-budget'

// Outbound side of the automation contract: ask the engine to research a lead.
//
// Design constraints (non-negotiable):
//   - Lead creation MUST succeed even if n8n is unreachable, slow, or misconfigured.
//   - If N8N_ADAPTER_URL or AUTOMATION_SHARED_SECRET is unset, this no-ops and logs.
//   - Never blocks the user's request path: work is scheduled with `after()`.
//   - Every request is recorded as a job, so failures are visible in the app,
//     not only in server logs. The engine's reply (lead.enriched) closes the job.

export type LeadEnrichmentInput = {
  organizationId: string
  leadId: string
  fullName?: string | null
  companyName?: string | null
  website?: string | null
}

const EMIT_TIMEOUT_MS = 8000
const JOB_TYPE = 'lead.enrichment'

/** Build the wire payload (contract: lead.enrichment.requested). */
export function buildLeadEnrichmentRequest(input: LeadEnrichmentInput): LeadEnrichmentRequested {
  return {
    event_id: randomUUID(),
    event_type: 'lead.enrichment.requested',
    organization_id: input.organizationId,
    subject_id: input.leadId,
    payload: {
      full_name: input.fullName ?? null,
      company_name: input.companyName ?? null,
      website: input.website ?? null,
    },
  }
}

async function send(event: LeadEnrichmentRequested, url: string, secret: string): Promise<void> {
  const service = createServiceClient()
  const jobKey = { event_id: event.event_id, organization_id: event.organization_id }

  const { error: jobError } = await service.from('jobs').insert({
    ...jobKey,
    job_type: JOB_TYPE,
    subject_type: 'lead',
    subject_id: event.subject_id,
    status: 'queued',
  })
  if (jobError) {
    // Still attempt the send: the job row is visibility, not a precondition.
    console.error(`[automation] could not record job event_id=${event.event_id}: ${jobError.message}`)
  }

  const markJob = async (patch: Record<string, unknown>) => {
    if (jobError) return
    const { error } = await service.from('jobs').update(patch).match(jobKey)
    if (error) console.error(`[automation] job update failed event_id=${event.event_id}: ${error.message}`)
  }

  // Paid research stops at the org's daily AI cap (spam on a public form must not run up a bill).
  const budget = await getAiBudget(service, event.organization_id)
  if (budget.exhausted) {
    console.warn(`[automation] enrichment skipped, ${budgetMessage(budget)} event_id=${event.event_id}`)
    await markJob({ status: 'failed', finished_at: new Date().toISOString(), error_message: `${budgetMessage(budget)}; not researched` })
    return
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [AUTOMATION_SECRET_HEADER]: secret },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(EMIT_TIMEOUT_MS),
      cache: 'no-store',
    })

    if (res.ok) {
      await markJob({ status: 'running', started_at: new Date().toISOString(), attempts: 1 })
    } else {
      console.error(`[automation] enrichment request rejected status=${res.status} event_id=${event.event_id}`)
      await markJob({
        status: 'failed',
        attempts: 1,
        finished_at: new Date().toISOString(),
        error_message: `engine rejected request (HTTP ${res.status})`,
      })
    }
  } catch (err) {
    // Network error, DNS failure, timeout. The lead already exists — this is not fatal.
    const message = err instanceof Error ? err.message : 'unknown error'
    console.error(`[automation] enrichment request failed: ${message} event_id=${event.event_id}`)
    await markJob({
      status: 'failed',
      attempts: 1,
      finished_at: new Date().toISOString(),
      error_message: `could not reach engine: ${message}`,
    })
  }
}

/**
 * Fire-and-forget request to research a newly created lead.
 *
 * Safe to call from any server action or route handler. Never throws, never rejects,
 * never blocks the response. Returns the event_id when a request was scheduled, or
 * null when the integration is not configured.
 */
export function requestLeadEnrichment(input: LeadEnrichmentInput): string | null {
  const url = process.env.N8N_ADAPTER_URL
  const secret = process.env.AUTOMATION_SHARED_SECRET

  if (!url || !secret) {
    const missing = !url ? 'N8N_ADAPTER_URL' : 'AUTOMATION_SHARED_SECRET'
    console.warn(`[automation] enrichment not requested (${missing} is not set) lead_id=${input.leadId}`)
    return null
  }

  const event = buildLeadEnrichmentRequest(input)
  const run = () => send(event, url, secret).catch((err) => {
    console.error(`[automation] enrichment send crashed event_id=${event.event_id}`, err)
  })

  try {
    // `after()` runs once the response has flushed and keeps the invocation alive.
    after(run)
  } catch {
    // Outside a request scope (e.g. a script or a test) `after()` throws.
    void run()
  }

  return event.event_id
}
