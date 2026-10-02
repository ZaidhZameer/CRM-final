import { describe, it, expect } from 'vitest'
import { DEFAULT_SOURCING_SETTINGS, validateSourcingSettings } from '../settings'

const ok = { ...DEFAULT_SOURCING_SETTINGS, sic_codes: ['86230'] }

describe('validateSourcingSettings', () => {
  it('accepts a normal configuration and cleans SIC codes and area', () => {
    const r = validateSourcingSettings({ ...ok, enabled: true, sic_codes: ['86230', ' 69102 ', 'bad'], location: '  Leeds ' })
    expect(r).toEqual({ ok: true, value: expect.objectContaining({ sic_codes: ['86230', '69102'], location: 'Leeds', enabled: true }) })
  })
  it('refuses to switch on with no industry chosen, but allows saving while off', () => {
    expect(validateSourcingSettings({ ...DEFAULT_SOURCING_SETTINGS, enabled: true })).toMatchObject({ ok: false })
    expect(validateSourcingSettings({ ...DEFAULT_SOURCING_SETTINGS, enabled: false })).toMatchObject({ ok: true })
  })
  it('bounds the daily limit and company age', () => {
    expect(validateSourcingSettings({ ...ok, daily_cap: 0 })).toMatchObject({ ok: false })
    expect(validateSourcingSettings({ ...ok, daily_cap: 500 })).toMatchObject({ ok: false })
    expect(validateSourcingSettings({ ...ok, daily_cap: 2.5 })).toMatchObject({ ok: false })
    expect(validateSourcingSettings({ ...ok, min_age_years: 5, max_age_years: 2 })).toMatchObject({ ok: false })
  })
  it('rejects unknown campaigns and markup in the area', () => {
    expect(validateSourcingSettings({ ...ok, campaign: 'spam' })).toMatchObject({ ok: false })
    expect(validateSourcingSettings({ ...ok, location: '<script>' })).toMatchObject({ ok: false })
  })
})
