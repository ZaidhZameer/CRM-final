import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isFirstBusinessDayOfQuarter, nextBusinessDaySendTime, nextFollowUpAfterSend } from '../follow-ups'
import { runReactivation } from '../reactivation'
import { buildDraftRequest } from '../automation/follow-up-drafts'
import { followUpDraftRequestedSchema } from '../automation/contract'

vi.mock('../gmail', () => ({
  getMailAccessToken: vi.fn(async () => 'token'),
  sendGmail: vi.fn(async () => ({ id: 'gmail-msg-1', threadId: 'gmail-thread-1' })),
}))
import { sendDueFollowUps } from '../follow-up-sender'

describe('isFirstBusinessDayOfQuarter (UK time)', () => {
  it('is true on the first weekday of Jan/Apr/Jul/Oct', () => {
    expect(isFirstBusinessDayOfQuarter(new Date('2026-10-01T09:00:00Z'))).toBe(true) // Thu
    expect(isFirstBusinessDayOfQuarter(new Date('2026-04-01T09:00:00Z'))).toBe(true) // Wed
    expect(isFirstBusinessDayOfQuarter(new Date('2026-01-01T09:00:00Z'))).toBe(true) // Thu (bank holiday not modelled)
  })
  it('rolls a weekend quarter start to the following Monday', () => {
    // 2026-02-01 is a Sunday (not a quarter month); 2025-06-01 likewise. July 2028: Sat 1st, Sun 2nd, Mon 3rd.
    expect(isFirstBusinessDayOfQuarter(new Date('2028-07-01T10:00:00Z'))).toBe(false) // Sat
    expect(isFirstBusinessDayOfQuarter(new Date('2028-07-02T10:00:00Z'))).toBe(false) // Sun
    expect(isFirstBusinessDayOfQuarter(new Date('2028-07-03T10:00:00Z'))).toBe(true) // Mon
    expect(isFirstBusinessDayOfQuarter(new Date('2028-07-04T10:00:00Z'))).toBe(false)
  })
  it('is false in non-quarter months and later days of a quarter month', () => {
    expect(isFirstBusinessDayOfQuarter(new Date('2026-11-02T09:00:00Z'))).toBe(false)
    expect(isFirstBusinessDayOfQuarter(new Date('2026-10-02T09:00:00Z'))).toBe(false)
    expect(isFirstBusinessDayOfQuarter(new Date('2026-12-01T09:00:00Z'))).toBe(false)
  })
  it('uses the London date, not the UTC date', () => {
    // 23:30 UTC on 30 Sep is 00:30 BST on Thu 1 Oct in London.
    expect(isFirstBusinessDayOfQuarter(new Date('2026-09-30T23:30:00Z'))).toBe(true)
    // 23:30 UTC on 1 Oct is already Fri 2 Oct in London.
    expect(isFirstBusinessDayOfQuarter(new Date('2026-10-01T23:30:00Z'))).toBe(false)
    // Winter: 00:30 UTC on Fri 2 Jan is still Fri 2 Jan London, but 1 Jan was the first business day.
    expect(isFirstBusinessDayOfQuarter(new Date('2026-01-02T00:30:00Z'))).toBe(false)
  })
})

describe('nextBusinessDaySendTime', () => {
  it('is 09:30 London on the next weekday', () => {
    expect(nextBusinessDaySendTime(new Date('2026-10-01T09:00:00Z')).toISOString()).toBe('2026-10-02T08:30:00.000Z') // BST
    expect(nextBusinessDaySendTime(new Date('2026-01-08T15:00:00Z')).toISOString()).toBe('2026-01-09T09:30:00.000Z') // GMT
  })
  it('skips weekends', () => {
    expect(nextBusinessDaySendTime(new Date('2026-10-02T09:00:00Z')).toISOString()).toBe('2026-10-05T08:30:00.000Z') // Fri -> Mon
    expect(nextBusinessDaySendTime(new Date('2026-10-03T09:00:00Z')).toISOString()).toBe('2026-10-05T08:30:00.000Z') // Sat -> Mon
  })
})

describe('runReactivation', () => {
  const rpc = vi.fn()
  const service = { rpc } as never
  beforeEach(() => rpc.mockReset())

  it('does nothing outside the first business day of a quarter', async () => {
    const r = await runReactivation(service, new Date('2026-10-02T09:00:00Z'))
    expect(r).toEqual({ ran: false, reason: 'not_quarter_start' })
    expect(rpc).not.toHaveBeenCalled()
  })
  it('schedules for the next business day 09:30 UK with 90 days / 25 per org', async () => {
    rpc.mockResolvedValue({ data: [{ scheduled: 7, skipped: 1 }], error: null })
    const r = await runReactivation(service, new Date('2026-10-01T09:00:00Z'))
    expect(r).toMatchObject({ ran: true, scheduled: 7, skipped: 1, scheduled_for: '2026-10-02T08:30:00.000Z' })
    expect(rpc).toHaveBeenCalledWith('schedule_reactivations', {
      p_scheduled_for: '2026-10-02T08:30:00.000Z', p_idle_days: 90, p_per_org: 25,
    })
  })
  it('runs any day when forced (?reactivate=1)', async () => {
    rpc.mockResolvedValue({ data: [{ scheduled: 0, skipped: 0 }], error: null })
    const r = await runReactivation(service, new Date('2026-11-12T09:00:00Z'), true)
    expect(r).toMatchObject({ ran: true, scheduled: 0 })
  })
  it('reports a database error instead of throwing', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } })
    expect(await runReactivation(service, new Date('2026-10-01T09:00:00Z'))).toEqual({ ran: true, error: 'boom' })
  })
})

describe('nextFollowUpAfterSend', () => {
  const sentAt = new Date('2026-10-14T10:00:00Z')
  it('schedules step 2 after a normal step 1', () => {
    expect(nextFollowUpAfterSend({ kind: 'follow_up', step: 1 }, sentAt)).toMatchObject({ step: 2 })
    expect(nextFollowUpAfterSend({ step: 1 }, sentAt)).toMatchObject({ step: 2 })
  })
  it('never schedules a step 2 after a reactivation', () => {
    expect(nextFollowUpAfterSend({ kind: 'reactivation', step: 1 }, sentAt)).toBeNull()
  })
  it('stops after the last cadence step', () => {
    expect(nextFollowUpAfterSend({ kind: 'follow_up', step: 3 }, sentAt)).toBeNull()
  })
})

// A minimal chainable fake of the Supabase client, enough for sendDueFollowUps.
function fakeService(kind: 'follow_up' | 'reactivation') {
  const inserts: { table: string; row: Record<string, unknown> }[] = []
  const queued = {
    id: 'm1', organization_id: 'o1', lead_id: 'l1', to_email: 'a@b.co', subject: 'Hi', body: 'Hello',
    approval_id: null, follow_up_id: 'f1',
  }
  const from = (table: string) => {
    const st = { op: 'select', single: false, head: false }
    const b: Record<string, unknown> = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => {
            if (st.op !== 'select') return resolve(st.op === 'update' && table === 'outreach_messages' ? { data: [{ id: 'm1' }], error: null } : { data: null, error: null })
            if (table === 'outreach_messages') {
              if (st.head) return resolve({ count: 0, data: null, error: null })
              return resolve({ data: st.single ? null : [queued], error: null })
            }
            if (table === 'follow_ups') return resolve({ data: { id: 'f1', status: 'pending', step: 1, kind, scheduled_for: '2026-10-01T08:30:00Z' }, error: null })
            if (table === 'mail_connections') return resolve({ data: { id: 'c1', organization_id: 'o1', email: 'z@x.co', status: 'connected' }, error: null })
            return resolve({ data: null, error: null })
          }
        }
        if (prop === 'select') return (_c?: string, opts?: { head?: boolean }) => { st.head = !!opts?.head; return b }
        if (prop === 'update') return () => { st.op = 'update'; return b }
        if (prop === 'insert') return (row: Record<string, unknown>) => { inserts.push({ table, row }); st.op = 'insert'; return b }
        if (prop === 'single' || prop === 'maybeSingle') return () => { st.single = true; return b }
        return () => b
      },
    })
    return b
  }
  return { service: { from } as never, inserts }
}

describe('sendDueFollowUps scheduling', () => {
  const now = new Date('2026-10-14T10:00:00Z') // Wednesday, inside the send window

  it('does not schedule a step 2 after sending a reactivation', async () => {
    const { service, inserts } = fakeService('reactivation')
    const r = await sendDueFollowUps(service, now)
    expect(r.sent).toBe(1)
    expect(inserts.filter((i) => i.table === 'follow_ups')).toEqual([])
  })

  it('still schedules step 2 after a normal step 1 (control)', async () => {
    const { service, inserts } = fakeService('follow_up')
    const r = await sendDueFollowUps(service, now)
    expect(r.sent).toBe(1)
    expect(inserts.filter((i) => i.table === 'follow_ups')).toHaveLength(1)
    expect(inserts.find((i) => i.table === 'follow_ups')!.row).toMatchObject({ step: 2, source: 'automation' })
  })
})

describe('buildDraftRequest purpose', () => {
  // Every lookup resolves to a lead with an email and no research/history.
  const service = {
    from: () => {
      const b: Record<string, unknown> = new Proxy({}, {
        get(_t, prop: string) {
          if (prop === 'then') return (res: (v: unknown) => void) => res({ data: [], error: null })
          if (prop === 'single' || prop === 'maybeSingle') {
            return () => ({
              then: (res: (v: unknown) => void) => res({
                data: { id: 'l1', name: 'Org', booking_answers_json: null, companies: { name: 'Acme' }, contacts: { full_name: 'Maya', email: 'm@acme.co', job_title: null }, profiles: { full_name: 'Zaid' } },
                error: null,
              }),
            })
          }
          return () => b
        },
      })
      return b
    },
  } as never
  const base = { id: '44444444-4444-4444-8444-444444444444', organization_id: '11111111-1111-4111-8111-111111111111', lead_id: '22222222-2222-4222-8222-222222222222', step: 1, scheduled_for: '2026-10-02T08:30:00Z' }

  it('sets purpose=reactivation and max_steps=1 from kind', async () => {
    const e = await buildDraftRequest(service, { ...base, kind: 'reactivation' })
    expect(e?.payload.purpose).toBe('reactivation')
    expect(e?.payload.max_steps).toBe(1)
  })
  it('defaults to follow_up', async () => {
    const e = await buildDraftRequest(service, { ...base, kind: 'follow_up' })
    expect(e?.payload.purpose).toBe('follow_up')
    expect(e?.payload.max_steps).toBe(3)
  })
  it('the schema accepts a request without purpose (older engines) and defaults it', () => {
    const { purpose: _p, ...payload } = (followUpDraftRequestedSchema.parse({
      event_id: '33333333-3333-4333-8333-333333333333', event_type: 'followup.draft.requested',
      organization_id: base.organization_id, subject_id: base.id,
      payload: {
        lead_id: base.lead_id, step: 1, max_steps: 3, scheduled_for: 'x', latest_allowed: 'y',
        contact: { full_name: null, email: 'a@b.co', company_name: null, job_title: null },
        research: null, enquiry: null, history: [], sender: { name: null, company: null },
        rules: { booking_link_allowed: false, max_words: 120 },
      },
    }) as { payload: Record<string, unknown> }).payload
    expect(_p).toBe('follow_up')
    expect(payload.step).toBe(1)
  })
})
