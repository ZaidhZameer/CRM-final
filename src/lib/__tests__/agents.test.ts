import { describe, it, expect } from 'vitest'
import { AGENTS, clampLevel, isAgentKey, levelAllows } from '../agents'

describe('agent registry', () => {
  it('recognises only registered agents', () => {
    expect(isAgentKey('seo')).toBe(true)
    expect(isAgentKey('toString')).toBe(false)
    expect(isAgentKey(undefined)).toBe(false)
  })
  it('clamps to each agent maximum and rejects junk', () => {
    expect(clampLevel('follow_up', 3)).toBe(1)
    expect(clampLevel('lead_finder', 3)).toBe(2)
    expect(clampLevel('seo', -4)).toBe(0)
    expect(clampLevel('seo', 1.5)).toBe(0)
    expect(clampLevel('seo', '2')).toBe(0)
  })
  it('no agent can exceed level 2', () => {
    for (const a of Object.values(AGENTS)) expect(a.maxLevel).toBeLessThanOrEqual(2)
  })
  it('only the lead finder is live; the rest are placeholders', () => {
    expect(Object.entries(AGENTS).filter(([, a]) => a.live).map(([k]) => k)).toEqual(['lead_finder'])
  })
  it('defaults to off, and the kill switch beats any level', () => {
    expect(levelAllows(false, undefined, 'seo', 1)).toBe(false)
    expect(levelAllows(false, 1, 'seo', 1)).toBe(true)
    expect(levelAllows(true, 2, 'lead_finder', 1)).toBe(false)
    expect(levelAllows(false, 1, 'lead_finder', 2)).toBe(false)
    expect(levelAllows(false, 2, 'lead_finder', 0)).toBe(false)
  })
})
