import { describe, it, expect } from 'vitest'
import { ukDayBounds, todayHeadline, needsYouCount } from '../today'

describe('ukDayBounds', () => {
  it('uses UTC midnight in winter (GMT)', () => {
    expect(ukDayBounds(new Date('2026-01-15T10:30:00Z'))).toEqual({
      start: '2026-01-15T00:00:00.000Z', end: '2026-01-16T00:00:00.000Z',
    })
  })
  it('starts at 23:00Z the previous day in summer (BST)', () => {
    expect(ukDayBounds(new Date('2026-07-01T12:00:00Z'))).toEqual({
      start: '2026-06-30T23:00:00.000Z', end: '2026-07-01T23:00:00.000Z',
    })
  })
  it('puts 23:30Z in summer into the next UK day', () => {
    expect(ukDayBounds(new Date('2026-07-01T23:30:00Z')).start).toBe('2026-07-01T23:00:00.000Z')
  })
  it('handles the spring-forward day (23 hours)', () => {
    expect(ukDayBounds(new Date('2026-03-29T12:00:00Z'))).toEqual({
      start: '2026-03-29T00:00:00.000Z', end: '2026-03-29T23:00:00.000Z',
    })
  })
  it('handles the autumn fall-back day (25 hours)', () => {
    expect(ukDayBounds(new Date('2026-10-25T12:00:00Z'))).toEqual({
      start: '2026-10-24T23:00:00.000Z', end: '2026-10-26T00:00:00.000Z',
    })
  })
  it('rolls over month ends', () => {
    expect(ukDayBounds(new Date('2026-01-31T12:00:00Z')).end).toBe('2026-02-01T00:00:00.000Z')
  })
})

describe('todayHeadline', () => {
  it('is all caught up at zero', () => {
    expect(todayHeadline({ approvals: 0, replies: 0, proposals: 0, problems: 0 })).toBe("You're all caught up")
  })
  it('uses singular and plural', () => {
    expect(todayHeadline({ approvals: 1, replies: 0, proposals: 0, problems: 0 })).toBe('1 thing needs you today')
    expect(todayHeadline({ approvals: 1, replies: 1, proposals: 1, problems: 0 })).toBe('3 things need you today')
  })
  it('sums approvals, replies, proposals and problems', () => {
    expect(needsYouCount({ approvals: 1, replies: 2, proposals: 3, problems: 4 })).toBe(10)
  })
})
