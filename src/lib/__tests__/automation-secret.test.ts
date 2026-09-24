import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { NextRequest } from 'next/server'
import {
  verifyAutomationSecret,
  verifyCronSecret,
  AUTOMATION_SECRET_HEADER,
  CRON_SECRET_HEADER,
} from '../automation/secret'
import { buildLeadEnrichmentRequest } from '../automation/events'
import { leadEnrichmentRequestedSchema, leadEnrichedSchema } from '../automation/contract'

const VALID = 'a-sufficiently-long-secret-value'

function req(headerValue?: string): NextRequest {
  const headers = new Headers()
  if (headerValue !== undefined) headers.set(AUTOMATION_SECRET_HEADER, headerValue)
  return { headers } as unknown as NextRequest
}

describe('verifyAutomationSecret', () => {
  const original = process.env.AUTOMATION_SHARED_SECRET

  beforeEach(() => {
    process.env.AUTOMATION_SHARED_SECRET = VALID
  })

  afterEach(() => {
    if (original === undefined) delete process.env.AUTOMATION_SHARED_SECRET
    else process.env.AUTOMATION_SHARED_SECRET = original
  })

  it('accepts an exact match', () => {
    expect(verifyAutomationSecret(req(VALID))).toEqual({ ok: true })
  })

  it('rejects a wrong secret', () => {
    expect(verifyAutomationSecret(req('nope-nope-nope-nope'))).toEqual({
      ok: false,
      reason: 'mismatch',
    })
  })

  it('rejects a prefix of the correct secret (no length short-circuit)', () => {
    expect(verifyAutomationSecret(req(VALID.slice(0, -1)))).toEqual({
      ok: false,
      reason: 'mismatch',
    })
  })

  it('rejects a missing header', () => {
    expect(verifyAutomationSecret(req())).toEqual({ ok: false, reason: 'missing_header' })
  })

  it('FAILS CLOSED when the secret is unset', () => {
    delete process.env.AUTOMATION_SHARED_SECRET
    expect(verifyAutomationSecret(req(VALID))).toEqual({ ok: false, reason: 'not_configured' })
    expect(verifyAutomationSecret(req())).toEqual({ ok: false, reason: 'not_configured' })
  })

  it('FAILS CLOSED when the secret is empty', () => {
    process.env.AUTOMATION_SHARED_SECRET = ''
    expect(verifyAutomationSecret(req(''))).toEqual({ ok: false, reason: 'not_configured' })
  })

  it('FAILS CLOSED when the secret is too short to be meaningful', () => {
    process.env.AUTOMATION_SHARED_SECRET = 'short'
    expect(verifyAutomationSecret(req('short'))).toEqual({ ok: false, reason: 'not_configured' })
  })
})

describe('buildLeadEnrichmentRequest', () => {
  it('produces a valid lead.enrichment.requested envelope with a fresh event_id', () => {
    const a = buildLeadEnrichmentRequest({
      organizationId: '0b5c1f9a-2f3e-4c1a-9f10-6d2b7e4a8c31',
      leadId: '8f2a7c44-91b2-4f55-b0de-3a6c9e1d2f40',
      fullName: 'Sam Okafor',
      companyName: 'Okafor Plumbing Ltd',
      website: 'https://okaforplumbing.co.uk',
    })

    expect(leadEnrichmentRequestedSchema.safeParse(a).success).toBe(true)
    expect(a.event_type).toBe('lead.enrichment.requested')
    expect(a.subject_id).toBe('8f2a7c44-91b2-4f55-b0de-3a6c9e1d2f40')

    const b = buildLeadEnrichmentRequest({ organizationId: a.organization_id, leadId: a.subject_id })
    expect(b.event_id).not.toBe(a.event_id)
    // Missing optional fields normalise to null, never undefined (JSON.stringify drops those).
    expect(b.payload).toEqual({ full_name: null, company_name: null, website: null })
  })
})

describe('leadEnrichedSchema', () => {
  const base = {
    event_id: '5d9b1a52-6a4e-4f7b-9d7e-2c1e8f3a4b60',
    event_type: 'lead.enriched',
    organization_id: '0b5c1f9a-2f3e-4c1a-9f10-6d2b7e4a8c31',
    subject_id: '8f2a7c44-91b2-4f55-b0de-3a6c9e1d2f40',
    correlation_id: '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d',
    payload: { research: { status: 'completed', lead_score: 72, pain_points: ['slow quotes'] } },
  }

  it('accepts a well-formed reply', () => {
    expect(leadEnrichedSchema.safeParse(base).success).toBe(true)
  })

  it('rejects the old flat shape (research at the top level)', () => {
    const { payload, ...rest } = base
    expect(leadEnrichedSchema.safeParse({ ...rest, research: payload.research }).success).toBe(false)
  })

  it('rejects a score out of range', () => {
    const bad = { ...base, payload: { research: { lead_score: 140 } } }
    expect(leadEnrichedSchema.safeParse(bad).success).toBe(false)
  })
})

describe('verifyCronSecret', () => {
  const original = process.env.CRON_SECRET
  const cronReq = (headers: Record<string, string>) =>
    ({ headers: new Headers(headers) }) as unknown as NextRequest

  afterEach(() => {
    if (original === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = original
  })

  it('fails closed when CRON_SECRET is unset', () => {
    delete process.env.CRON_SECRET
    expect(verifyCronSecret(cronReq({ [CRON_SECRET_HEADER]: 'anything-at-all-here' }))).toEqual({
      ok: false,
      reason: 'not_configured',
    })
  })

  it('accepts the secret in the header', () => {
    process.env.CRON_SECRET = VALID
    expect(verifyCronSecret(cronReq({ [CRON_SECRET_HEADER]: VALID }))).toEqual({ ok: true })
  })

  it('does not accept the automation header in place of the cron header', () => {
    process.env.CRON_SECRET = VALID
    expect(verifyCronSecret(cronReq({ [AUTOMATION_SECRET_HEADER]: VALID }))).toEqual({
      ok: false,
      reason: 'missing_header',
    })
  })
})
