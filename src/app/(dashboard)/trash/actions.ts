'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { validate, uuidSchema } from '@/lib/validate'

export async function getTrashedLeads() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/sign-in')

  const service = createServiceClient()

  const { data: profile } = await service
    .from('profiles')
    .select('id, default_organization_id')
    .eq('user_id', user.id)
    .single()

  if (!profile?.default_organization_id) return { leads: [] }

  const { data } = await service
    .from('leads')
    .select('id, status, lead_quality, lead_score, deleted_at, companies(name), contacts(full_name, email)')
    .eq('organization_id', profile.default_organization_id)
    .not('deleted_at', 'is', null)
    .order('deleted_at', { ascending: false })
    .limit(100)

  return {
    leads: (data ?? []).map((l: any) => ({
      id: l.id,
      companyName: l.companies?.name ?? null,
      status: l.status,
      quality: l.lead_quality,
      score: l.lead_score,
      deletedAt: l.deleted_at,
      // leads.contact_id is many-to-one, so PostgREST embeds a single object, not an array
      contactName: l.contacts?.full_name ?? null,
      contactEmail: l.contacts?.email ?? null,
    })),
  }
}

export async function restoreLead(leadId: string) {
  const idCheck = validate(uuidSchema, leadId)
  if (idCheck.error) return { error: 'Invalid lead ID' }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/sign-in')

  const service = createServiceClient()

  const { data: profile } = await service
    .from('profiles')
    .select('id, default_organization_id')
    .eq('user_id', user.id)
    .single()

  if (!profile?.default_organization_id) return { error: 'No org' }

  const rl = await RATE_LIMITS.write(user.id)
  if (!rl.success) return { error: `Too many requests. Try again in ${rl.resetIn}s.` }

  try {
    const { error } = await service
      .from('leads')
      .update({ deleted_at: null })
      .eq('id', leadId)
      .eq('organization_id', profile.default_organization_id)

    if (error) return { error: error.message }

    await service.from('activity_logs').insert({
      organization_id: profile.default_organization_id,
      actor_profile_id: profile.id,
      action: 'restored',
      entity_type: 'lead',
      entity_id: leadId,
    })

    return { success: true }
  } catch {
    return { error: 'Something went wrong. Please try again.' }
  }
}

export async function softDeleteLead(leadId: string) {
  const idCheck = validate(uuidSchema, leadId)
  if (idCheck.error) return { error: 'Invalid lead ID' }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/sign-in')

  const service = createServiceClient()

  const { data: profile } = await service
    .from('profiles')
    .select('id, default_organization_id')
    .eq('user_id', user.id)
    .single()

  if (!profile?.default_organization_id) return { error: 'No org' }

  const rl = await RATE_LIMITS.write(user.id)
  if (!rl.success) return { error: `Too many requests. Try again in ${rl.resetIn}s.` }

  try {
    const { error } = await service
      .from('leads')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', leadId)
      .eq('organization_id', profile.default_organization_id)

    if (error) return { error: error.message }

    await service.from('activity_logs').insert({
      organization_id: profile.default_organization_id,
      actor_profile_id: profile.id,
      action: 'deleted',
      entity_type: 'lead',
      entity_id: leadId,
    })

    return { success: true }
  } catch {
    return { error: 'Something went wrong. Please try again.' }
  }
}
