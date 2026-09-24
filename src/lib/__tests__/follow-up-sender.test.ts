import { describe, it, expect } from 'vitest'
import { isSendWindow, threadedSubject } from '../follow-up-sender'

describe('isSendWindow (UK business hours)', () => {
  it('allows a weekday morning', () => {
    expect(isSendWindow(new Date('2026-01-14T09:30:00Z'))).toBe(true) // Wed 09:30 GMT
  })
  it('blocks evenings, early mornings and weekends', () => {
    expect(isSendWindow(new Date('2026-01-14T18:00:00Z'))).toBe(false) // Wed 18:00
    expect(isSendWindow(new Date('2026-01-14T07:59:00Z'))).toBe(false) // Wed 07:59
    expect(isSendWindow(new Date('2026-01-17T10:00:00Z'))).toBe(false) // Sat
  })
  it('uses UK summer time (07:30 UTC in July is 08:30 BST)', () => {
    expect(isSendWindow(new Date('2026-07-15T07:30:00Z'))).toBe(true)
    expect(isSendWindow(new Date('2026-07-15T17:30:00Z'))).toBe(false) // 18:30 BST
  })
})

describe('threadedSubject', () => {
  it('keeps the first subject with Re: for later steps', () => {
    expect(threadedSubject('Quick idea for Harbor Dental', 'Another thought')).toBe('Re: Quick idea for Harbor Dental')
  })
  it('does not double the prefix, and uses the new subject for step 1', () => {
    expect(threadedSubject('Re: Hello', 'x')).toBe('Re: Hello')
    expect(threadedSubject(null, 'Quick idea')).toBe('Quick idea')
  })
})
