'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { RATE_LIMITS } from '@/lib/rate-limit'
import {
  AGENCY_PROFILE_FIELDS,
  EMPTY_AGENCY_PROFILE,
  validateAgencyProfile,
  type AgencyProfileFields,
} from '@/lib/agency-profile'

export type AgencyProfile = {
  fields: AgencyProfileFields
  version: number | null // null until the first save creates the row
  canManage: boolean // owner/admin
}

const CONFLICT = 'Someone else changed the agency profile while you were editing. Reload to see their changes, then save again.'

async function context() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/sign-in')
  const service = createServiceClient()
  const { data: profile } = await service
    .from('profiles')
    .select('id, default_organization_id')
    .eq('user_id', user.id)
    .single()
  const orgId = profile?.default_organization_id ?? null
  const { data: membership } = orgId
    ? await service
        .from('memberships')
        .select('role')
        .eq('profile_id', profile!.id)
        .eq('organization_id', orgId)
        .eq('status', 'active')
        .maybeSingle()
    : { data: null }
  return {
    service,
    userId: user.id,
    profileId: (profile?.id ?? null) as string | null,
    orgId,
    canManage: ['owner', 'admin'].includes(membership?.role ?? ''),
  }
}

const SELECT = `version, ${AGENCY_PROFILE_FIELDS.join(', ')}`

export async function getAgencyProfile(): Promise<AgencyProfile> {
  const { service, orgId, canManage } = await context()
  const empty: AgencyProfile = { fields: { ...EMPTY_AGENCY_PROFILE }, version: null, canManage }
  if (!orgId) return empty
  const { data } = await service
    .from('client_context')
    .select(SELECT)
    .eq('organization_id', orgId)
    .is('company_id', null)
    .is('deleted_at', null)
    .maybeSingle()
  if (!data) return empty
  const row = data as unknown as Record<string, string | number | null>
  const fields = { ...EMPTY_AGENCY_PROFILE }
  for (const f of AGENCY_PROFILE_FIELDS) fields[f] = (row[f] as string | null) ?? ''
  return { fields, version: row.version as number, canManage }
}

/** expectedVersion is the version the editor loaded (null when no row existed yet). */
export async function saveAgencyProfile(
  fields: AgencyProfileFields,
  expectedVersion: number | null,
): Promise<{ error?: string; version?: number }> {
  const { service, userId, profileId, orgId, canManage } = await context()
  if (!orgId || !profileId) return { error: 'No organization' }
  if (!canManage) return { error: 'Only owners and admins can edit the agency profile.' }

  const rl = await RATE_LIMITS.write(userId)
  if (!rl.success) return { error: `Too many requests. Try again in ${rl.resetIn}s.` }

  const v = validateAgencyProfile(fields)
  if (!v.ok) return { error: v.error }

  if (expectedVersion == null) {
    const { data, error } = await service
      .from('client_context')
      .insert({ organization_id: orgId, company_id: null, updated_by: profileId, ...v.value })
      .select('version')
      .single()
    // 23505: another admin created the row first (unique org + NULL company).
    if (error?.code === '23505') return { error: CONFLICT }
    if (error || !data) return { error: 'Could not save the agency profile. Please try again.' }
    return { version: data.version }
  }

  const { data, error } = await service
    .from('client_context')
    .update({ ...v.value, updated_by: profileId, version: expectedVersion + 1 })
    .eq('organization_id', orgId)
    .is('company_id', null)
    .is('deleted_at', null)
    .eq('version', expectedVersion)
    .select('version')
    .maybeSingle()
  if (error) return { error: 'Could not save the agency profile. Please try again.' }
  if (!data) return { error: CONFLICT }
  return { version: data.version }
}
