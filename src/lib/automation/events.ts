import { randomUUID } from 'node:crypto'
import { after } from 'next/server'
import { AUTOMATION_SECRET_HEADER } from './secret'

// Outbound side of the n8n integration: emit `lead.created` to the n8n FlowLead adapter.
//
// Design constraints (non-negotiable):
//   - Lead creation MUST succeed even if n8n is unreachable, slow, or misconfigured.
//   - If N8N_ADAPTER_URL or AUTOMATION_SHARED_SECRET is unset, this no-ops and logs.
//   - Never blocks the user's request path: the POST is scheduled with `after()` so it
//     runs once the response has been sent, and any failure is swallowed after logging.

export type LeadCreatedEvent = {
  event_id: string
  event_type: 'lead.created'
  organization_id: string
  lead_id: string
  full_name: string | null
  company_name: string | null
  website: string | null
}

export type LeadCreatedInput = {
  organizationId: string
  leadId: string
  fullName?: string | null
  companyName?: string | null
  website?: string | null
}

const EMIT_TIMEOUT_MS = 8000

function logSkip(reason: string, leadId: string) {
  console.warn(`[automation] lead.created not emitted (${reason}) lead_id=${leadId}`)
}

/** Build the wire payload. Exported for tests and for the OpenAPI contract to mirror. */
export function buildLeadCreatedEvent(input: LeadCreatedInput): LeadCreatedEvent {
  return {
    event_id: randomUUID(),
    event_type: 'lead.created',
    organization_id: input.organizationId,
    lead_id: input.leadId,
    full_name: input.fullName ?? null,
    company_name: input.companyName ?? null,
    website: input.website ?? null,
  }
}

async function post(event: LeadCreatedEvent, url: string, secret: string): Promise<void> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [AUTOMATION_SECRET_HEADER]: secret,
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(EMIT_TIMEOUT_MS),
      cache: 'no-store',
    })

    if (!res.ok) {
      console.error(
        `[automation] lead.created rejected by adapter status=${res.status} ` +
          `event_id=${event.event_id} lead_id=${event.lead_id}`
      )
    }
  } catch (err) {
    // Network error, DNS failure, timeout. The lead already exists — this is not fatal.
    const message = err instanceof Error ? err.message : 'unknown error'
    console.error(
      `[automation] lead.created emit failed: ${message} ` +
        `event_id=${event.event_id} lead_id=${event.lead_id}`
    )
  }
}

/**
 * Fire-and-forget emit of `lead.created` to the n8n adapter.
 *
 * Safe to call from any server action or route handler. Never throws, never rejects,
 * never blocks the response. Returns the event_id when an emit was scheduled, or null
 * when the integration is not configured.
 */
export function emitLeadCreated(input: LeadCreatedInput): string | null {
  const url = process.env.N8N_ADAPTER_URL
  const secret = process.env.AUTOMATION_SHARED_SECRET

  if (!url) {
    logSkip('N8N_ADAPTER_URL is not set', input.leadId)
    return null
  }
  if (!secret) {
    logSkip('AUTOMATION_SHARED_SECRET is not set', input.leadId)
    return null
  }

  const event = buildLeadCreatedEvent(input)

  try {
    // `after()` runs the callback once the response has flushed, and keeps the
    // serverless invocation alive long enough for it to finish.
    after(() => post(event, url, secret))
  } catch {
    // Outside a request scope (e.g. a script or a test) `after()` throws.
    // Fall back to a floating promise rather than failing the caller.
    void post(event, url, secret)
  }

  return event.event_id
}
