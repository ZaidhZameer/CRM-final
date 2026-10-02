// Starting SIC code presets (Zaid's chosen niches, 2026-10-02). Owners edit these in Settings.
// "agencies" is a SEPARATE campaign: those companies are potential FlowLead customers/partners,
// not buyers of websites, so they get a different pitch.

export type Campaign = 'websites' | 'agencies'

export type SicPreset = { key: string; label: string; campaign: Campaign; sicCodes: string[] }

export const SIC_PRESETS: SicPreset[] = [
  { key: 'dentists_clinics', label: 'Dentists & clinics', campaign: 'websites', sicCodes: ['86230', '86900'] },
  { key: 'professional_services', label: 'Professional services (solicitors, accountants, consultants)', campaign: 'websites', sicCodes: ['69102', '69201', '69202', '70229'] },
  { key: 'agencies_like_us', label: 'Small agencies & web/tech businesses ("like us")', campaign: 'agencies', sicCodes: ['62012', '62020', '63120', '73110'] },
]

/** SIC codes are 5 digits. Anything else is dropped so a typo can't widen the search. */
export function cleanSicCodes(input: string[]): string[] {
  return [...new Set(input.map((s) => s.trim()).filter((s) => /^\d{5}$/.test(s)))].slice(0, 20)
}
