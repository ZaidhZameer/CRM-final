import { describe, it, expect } from 'vitest'
import { topThemes } from '../marketing'

describe('topThemes', () => {
  it('ranks themes, counting each report once and ignoring case and punctuation', () => {
    const out = topThemes([
      ['No online booking.', 'Slow mobile site'],
      ['no online booking', 'No online booking'],
      ['Slow mobile site!', 'Outdated design'],
    ])
    expect(out[0]).toEqual({ theme: 'No online booking.', count: 2 })
    expect(out[1].count).toBe(2)
    expect(out.map((t) => t.theme)).toContain('Outdated design')
  })
  it('ignores junk and non-lists, and respects the limit', () => {
    expect(topThemes([null, 'x', [''], [null], { a: 1 }])).toEqual([])
    expect(topThemes([['alpha one', 'beta two', 'gamma three']], 2)).toHaveLength(2)
  })
})
