'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { DEFAULT_SOURCING_SETTINGS, validateSourcingSettings, type SourcingSettingsInput } from '@/lib/sourcing/settings'

// "Lead sourcing" settings. Owner/admin only; tables are service-role only (see the
// 20261002000001 migration), so everything goes through here. Never returns keys.

export type SourcingCard = {
  settings: SourcingSettingsInput
  canManage: boolean
  keyConfigured: boolean // is COMPANIES_HOUSE_API_KEY set on the server (never the key itself)
  createdLast7Days: number
  foundLast7Days: number
  coldSendingConfirmed: boolean
}

async function context() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/sign-in')
  const service = createServiceClient()
  const { data: profile } = await service.from('profiles').select('id, default_organization_id').eq('user_id', user.id).single()
  const orgId = profile?.default_organization_id ?? null
  const { data: membership } = orgId
    ? await service.from('memberships').select('role').eq('profile_id', profile!.id).eq('organization_id', orgId).eq('status', 'active').maybeSingle()
    : { data: null }
  return { service, userId: user.id, profileId: (profile?.id ?? null) as string | null, orgId, canManage: ['owner', 'admin'].includes(membership?.role ?? '') }
}

export async function getSourcingCard(): Promise<SourcingCard> {
  const { service, orgId, canManage } = await context()
  const base: SourcingCard = {
    settings: { ...DEFAULT_SOURCING_SETTINGS }, canManage, keyConfigured: Boolean(process.env.COMPANIES_HOUSE_API_KEY),
    createdLast7Days: 0, foundLast7Days: 0, coldSendingConfirmed: false,
  }
  if (!orgId) return base
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString()
  const [{ data: s }, { count: found }, { count: created }] = await Promise.all([
    service.from('sourcing_settings').select('enabled, campaign, sic_codes, location, min_age_years, max_age_years, daily_cap, cold_sending_confirmed').eq('organization_id', orgId).maybeSingle(),
    service.from('sourced_companies').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).gte('found_at', weekAgo),
    service.from('sourced_companies').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).eq('status', 'lead_created').gte('found_at', weekAgo),
  ])
  return {
    ...base,
    settings: s
      ? { enabled: s.enabled, campaign: s.campaign, sic_codes: s.sic_codes ?? [], location: s.location ?? '', min_age_years: s.min_age_years, max_age_years: s.max_age_years, daily_cap: s.daily_cap }
      : base.settings,
    foundLast7Days: found ?? 0,
    createdLast7Days: created ?? 0,
    coldSendingConfirmed: s?.cold_sending_confirmed ?? false,
  }
}

export async function saveSourcingSettings(input: SourcingSettingsInput): Promise<{ error?: string }> {
  const { service, userId, profileId, orgId, canManage } = await context()
  if (!orgId) return { error: 'No organization' }
  if (!canManage) return { error: 'Only owners and admins can change lead sourcing.' }
  const rl = await RATE_LIMITS.write(userId)
  if (!rl.success) return { error: `Too many requests. Try again in ${rl.resetIn}s.` }

  const v = validateSourcingSettings(input)
  if (!v.ok) return { error: v.error }

  // cold_sending_confirmed is deliberately NOT editable here: it stays off until the owner has a
  // separate sending domain set up (it gets its own explicit control in the first-touch unit).
  const { error } = await service.from('sourcing_settings').upsert(
    { organization_id: orgId, ...v.value, updated_by: profileId, updated_at: new Date().toISOString() },
    { onConflict: 'organization_id' }
  )
  return error ? { error: 'Could not save. Please try again.' } : {}
}
