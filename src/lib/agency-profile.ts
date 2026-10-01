// Pure validation for the org's own agency profile (client_context row with company_id NULL).
// Plain text only: this text is fed to the proposal drafter, so markup is rejected, not stripped.

export const AGENCY_PROFILE_FIELDS = [
  'services', 'brand_voice', 'audience', 'competitors', 'past_work', 'do_rules', 'dont_rules',
] as const

export type AgencyProfileField = (typeof AGENCY_PROFILE_FIELDS)[number]
export type AgencyProfileFields = Record<AgencyProfileField, string>

export const AGENCY_PROFILE_LABELS: Record<AgencyProfileField, string> = {
  services: 'Services',
  brand_voice: 'Brand voice',
  audience: 'Audience',
  competitors: 'Competitors',
  past_work: 'Past work',
  do_rules: 'Always do',
  dont_rules: 'Never do',
}

export const AGENCY_PROFILE_LIMITS: Record<AgencyProfileField, number> = {
  services: 5000,
  past_work: 5000,
  brand_voice: 2000,
  audience: 2000,
  competitors: 2000,
  do_rules: 2000,
  dont_rules: 2000,
}

export const EMPTY_AGENCY_PROFILE: AgencyProfileFields = {
  services: '', brand_voice: '', audience: '', competitors: '', past_work: '', do_rules: '', dont_rules: '',
}

// An opening or closing tag, comment or doctype: "<b>", "</p>", "<a href=...>", "<!--".
const HTML_TAG = /<\s*\/?\s*[a-z!][^>]*>?/i

export type AgencyProfileResult =
  | { ok: true; value: Record<AgencyProfileField, string | null> }
  | { ok: false; error: string; field?: AgencyProfileField }

/** Trim, enforce per-field limits, reject HTML. Empty fields become null. */
export function validateAgencyProfile(input: unknown): AgencyProfileResult {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const value = {} as Record<AgencyProfileField, string | null>
  for (const field of AGENCY_PROFILE_FIELDS) {
    const v = raw[field]
    if (v != null && typeof v !== 'string') {
      return { ok: false, field, error: `${AGENCY_PROFILE_LABELS[field]} must be text.` }
    }
    const text = (v ?? '').trim()
    if (text.length > AGENCY_PROFILE_LIMITS[field]) {
      return { ok: false, field, error: `${AGENCY_PROFILE_LABELS[field]} is too long (max ${AGENCY_PROFILE_LIMITS[field]} characters).` }
    }
    if (HTML_TAG.test(text)) {
      return { ok: false, field, error: `${AGENCY_PROFILE_LABELS[field]} must be plain text (remove any HTML tags).` }
    }
    value[field] = text === '' ? null : text
  }
  return { ok: true, value }
}
