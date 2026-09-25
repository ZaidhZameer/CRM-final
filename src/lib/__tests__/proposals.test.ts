import { describe, it, expect } from 'vitest'
import { stripMoney, sanitizeSections, PRICE_PLACEHOLDER as P } from '../proposals'

describe('stripMoney: the AI never prices', () => {
  it('removes symbol amounts, thousands and decimals', () => {
    expect(stripMoney('Total £2,400 for the build')).toBe(`Total ${P} for the build`)
    expect(stripMoney('from $1,250.50')).toBe(`from ${P}`)
    expect(stripMoney('about €3k')).toBe(`about ${P}`)
    expect(stripMoney('£900 + VAT per month')).toBe(`${P} per month`)
  })
  it('removes word-currency amounts', () => {
    expect(stripMoney('2,400 GBP one-off')).toBe(`${P} one-off`)
    expect(stripMoney('roughly 1.5k pounds')).toBe(`roughly ${P}`)
  })
  it('collapses ranges into one placeholder', () => {
    expect(stripMoney('between £2k - £3k')).toBe(`between ${P}`)
    expect(stripMoney('£2k to £3k')).toBe(P)
  })
  it('leaves non-money numbers alone', () => {
    expect(stripMoney('Launch in 6 weeks with 3 revision rounds for 40% faster onboarding')).toBe('Launch in 6 weeks with 3 revision rounds for 40% faster onboarding')
    expect(stripMoney('Phase 2 starts in 2027')).toBe('Phase 2 starts in 2027')
  })
})

describe('sanitizeSections', () => {
  it('strips prices from every section and drops empty list items', () => {
    const out = sanitizeSections({
      summary: 'A rebuild for £5,000.', situation: 's', solution: 'x', timeline: '4 weeks',
      scope: ['Design', '  ', 'Hosting at $20 per month'], assumptions: ['Content supplied'], next_steps: 'Sign and pay £500 deposit',
    })
    expect(out.summary).toBe(`A rebuild for ${P}.`)
    expect(out.scope).toEqual(['Design', `Hosting at ${P} per month`])
    expect(out.next_steps).toBe(`Sign and pay ${P} deposit`)
  })
})
