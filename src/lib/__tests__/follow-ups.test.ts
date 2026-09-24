import { describe, it, expect } from 'vitest'
import { scheduledSendTime, MAX_AUTOMATED_STEPS } from '../follow-ups'

describe('scheduledSendTime', () => {
  it('step 1 is 3 business days later at 09:30 London (winter, GMT = UTC)', () => {
    // Monday 2026-01-12 15:00 UTC -> Thursday 2026-01-15 09:30 GMT
    expect(scheduledSendTime(new Date('2026-01-12T15:00:00Z'), 1)?.toISOString()).toBe('2026-01-15T09:30:00.000Z')
  })

  it('skips weekends', () => {
    // Thursday 2026-01-15 -> 3 business days -> Tuesday 2026-01-20
    expect(scheduledSendTime(new Date('2026-01-15T10:00:00Z'), 1)?.toISOString()).toBe('2026-01-20T09:30:00.000Z')
  })

  it('uses BST in summer (09:30 London = 08:30 UTC)', () => {
    // Wednesday 2026-07-01 -> 3 business days -> Monday 2026-07-06
    expect(scheduledSendTime(new Date('2026-07-01T12:00:00Z'), 1)?.toISOString()).toBe('2026-07-06T08:30:00.000Z')
  })

  it('counts from the London date, not the UTC date, near midnight', () => {
    // 23:30 UTC on Sunday 2026-07-05 is 00:30 Monday in London -> +3 business days = Thursday 07-09
    expect(scheduledSendTime(new Date('2026-07-05T23:30:00Z'), 1)?.toISOString()).toBe('2026-07-09T08:30:00.000Z')
  })

  it('later steps use their own gaps and stop after the last step', () => {
    // Step 2 = 4 business days: Monday 2026-01-12 -> Friday 2026-01-16
    expect(scheduledSendTime(new Date('2026-01-12T15:00:00Z'), 2)?.toISOString()).toBe('2026-01-16T09:30:00.000Z')
    expect(scheduledSendTime(new Date('2026-01-12T15:00:00Z'), MAX_AUTOMATED_STEPS + 1)).toBeNull()
  })
})
