import { cleanSicCodes } from './presets'

// Validation for the "Lead sourcing" settings card. Pure, so it is unit-tested; the server action
// calls it before anything is written.

export type SourcingSettingsInput = {
  enabled: boolean
  campaign: string
  sic_codes: string[]
  location: string
  min_age_years: number
  max_age_years: number
  daily_cap: number
}

export type SourcingSettingsClean = {
  enabled: boolean
  campaign: 'websites' | 'agencies'
  sic_codes: string[]
  location: string | null
  min_age_years: number
  max_age_years: number
  daily_cap: number
}

export const DEFAULT_SOURCING_SETTINGS: SourcingSettingsInput = {
  enabled: false,
  campaign: 'websites',
  sic_codes: [],
  location: '',
  min_age_years: 1,
  max_age_years: 10,
  daily_cap: 10,
}

export function validateSourcingSettings(
  input: SourcingSettingsInput
): { ok: true; value: SourcingSettingsClean } | { ok: false; error: string } {
  const campaign = input.campaign === 'agencies' ? 'agencies' : input.campaign === 'websites' ? 'websites' : null
  if (!campaign) return { ok: false, error: 'Unknown campaign.' }

  const sic = cleanSicCodes(input.sic_codes)
  if (input.enabled && sic.length === 0) return { ok: false, error: 'Pick at least one industry (a 5-digit SIC code) before switching sourcing on.' }

  const int = (n: unknown) => (typeof n === 'number' && Number.isInteger(n) ? n : NaN)
  const min = int(input.min_age_years)
  const max = int(input.max_age_years)
  const cap = int(input.daily_cap)
  if (!(min >= 0 && min <= 50) || !(max >= 0 && max <= 100)) return { ok: false, error: 'Company age must be a whole number of years.' }
  if (max < min) return { ok: false, error: 'The maximum company age must be at least the minimum.' }
  if (!(cap >= 1 && cap <= 50)) return { ok: false, error: 'The daily limit must be between 1 and 50.' }

  const location = (input.location ?? '').trim()
  if (location.length > 80) return { ok: false, error: 'Area is too long.' }
  if (/[<>]/.test(location)) return { ok: false, error: 'Area must be plain text.' }

  return {
    ok: true,
    value: { enabled: !!input.enabled, campaign, sic_codes: sic, location: location || null, min_age_years: min, max_age_years: max, daily_cap: cap },
  }
}
