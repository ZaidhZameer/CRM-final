import { describe, it, expect } from 'vitest'
import { displayCompanyName, normaliseCompanyName } from '../names'
import { cleanSicCodes, SIC_PRESETS } from '../presets'

describe('normaliseCompanyName', () => {
  it('ignores case, punctuation and legal suffixes so duplicates are caught', () => {
    expect(normaliseCompanyName('HARBOR DENTAL LTD.')).toBe('harbor dental')
    expect(normaliseCompanyName('Harbor Dental Limited')).toBe('harbor dental')
    expect(normaliseCompanyName('Smith & Jones LLP')).toBe('smith and jones')
  })
  it('keeps a name that is only a suffix word', () => {
    expect(normaliseCompanyName('Limited')).toBe('limited')
  })
})

describe('displayCompanyName', () => {
  it('turns Companies House capitals into readable names', () => {
    expect(displayCompanyName('HARBOR DENTAL LTD')).toBe('Harbor Dental Ltd')
    expect(displayCompanyName('NORTHSIDE ROOFING UK LLP')).toBe('Northside Roofing UK LLP')
  })
})

describe('cleanSicCodes / presets', () => {
  it('keeps only 5-digit codes, deduped', () => {
    expect(cleanSicCodes(['86230', ' 86230 ', '8623', 'abcde', '69102'])).toEqual(['86230', '69102'])
  })
  it('every preset has valid codes, and the agencies preset is its own campaign', () => {
    for (const p of SIC_PRESETS) expect(cleanSicCodes(p.sicCodes)).toEqual(p.sicCodes)
    expect(SIC_PRESETS.find((p) => p.key === 'agencies_like_us')?.campaign).toBe('agencies')
  })
})
