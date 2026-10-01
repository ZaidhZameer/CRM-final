import { describe, it, expect } from 'vitest'
import { validateAgencyProfile, AGENCY_PROFILE_LIMITS, EMPTY_AGENCY_PROFILE } from '../agency-profile'

describe('validateAgencyProfile', () => {
  it('trims and maps empty to null', () => {
    const r = validateAgencyProfile({ ...EMPTY_AGENCY_PROFILE, services: '  Websites  ', audience: '   ' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.services).toBe('Websites')
      expect(r.value.audience).toBeNull()
      expect(r.value.past_work).toBeNull()
    }
  })

  it('accepts text at the limit and rejects one over', () => {
    expect(validateAgencyProfile({ services: 'a'.repeat(AGENCY_PROFILE_LIMITS.services) }).ok).toBe(true)
    expect(validateAgencyProfile({ services: 'a'.repeat(5001) })).toMatchObject({ ok: false, field: 'services' })
    expect(validateAgencyProfile({ brand_voice: 'a'.repeat(2000) }).ok).toBe(true)
    expect(validateAgencyProfile({ brand_voice: 'a'.repeat(2001) })).toMatchObject({ ok: false, field: 'brand_voice' })
    expect(validateAgencyProfile({ past_work: 'a'.repeat(5001) })).toMatchObject({ ok: false, field: 'past_work' })
  })

  it('applies the limit after trimming', () => {
    expect(validateAgencyProfile({ audience: ' ' + 'a'.repeat(2000) + ' ' }).ok).toBe(true)
  })

  it('rejects HTML tags', () => {
    for (const bad of ['<script>alert(1)</script>', 'Hi <b>there</b>', '<a href="x">link</a>', '<!-- c -->', '< img src=x>']) {
      expect(validateAgencyProfile({ do_rules: bad })).toMatchObject({ ok: false, field: 'do_rules' })
    }
  })

  it('allows plain text with angle-bracket maths and ampersands', () => {
    expect(validateAgencyProfile({ services: 'Sites under $2k, 5 < 10 days, R&D, a > b' }).ok).toBe(true)
  })

  it('rejects non-string values and tolerates missing input', () => {
    expect(validateAgencyProfile({ services: 42 })).toMatchObject({ ok: false, field: 'services' })
    expect(validateAgencyProfile(null).ok).toBe(true)
  })
})
