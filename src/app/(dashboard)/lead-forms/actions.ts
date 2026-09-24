'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { createLeadFromSubmission } from '@/lib/lead-intake'

export async function getLeadForms() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/sign-in')

  const service = createServiceClient()

  const { data: profile } = await service
    .from('profiles')
    .select('id, default_organization_id')
    .eq('user_id', user.id)
    .single()

  if (!profile?.default_organization_id) return { forms: [] }

  const { data } = await service
    .from('lead_forms')
    .select('id, name, slug, is_active, submission_count, created_at')
    .eq('organization_id', profile.default_organization_id)
    .order('created_at', { ascending: false })

  return { forms: data ?? [] }
}

export async function createLeadForm(name: string) {
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
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      + '-' + crypto.randomUUID().slice(0, 8)

    const { data, error } = await service
      .from('lead_forms')
      .insert({
        organization_id: profile.default_organization_id,
        name: name.trim(),
        slug,
        created_by: profile.id,
      })
      .select('id, slug')
      .single()

    if (error) return { error: error.message }
    return { success: true, id: data.id, slug: data.slug }
  } catch {
    return { error: 'Something went wrong. Please try again.' }
  }
}

export async function toggleFormActive(formId: string, isActive: boolean) {
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
    await service
      .from('lead_forms')
      .update({ is_active: isActive })
      .eq('id', formId)
      .eq('organization_id', profile.default_organization_id)

    return { success: true }
  } catch {
    return { error: 'Something went wrong. Please try again.' }
  }
}

export async function getFormSubmissions(formId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/sign-in')

  const service = createServiceClient()

  const { data: profile } = await service
    .from('profiles')
    .select('id, default_organization_id')
    .eq('user_id', user.id)
    .single()

  if (!profile?.default_organization_id) return { submissions: [] }

  const { data } = await service
    .from('lead_form_submissions')
    .select('id, data_json, converted_lead_id, created_at')
    .eq('form_id', formId)
    .eq('organization_id', profile.default_organization_id)
    .order('created_at', { ascending: false })
    .limit(100)

  return { submissions: data ?? [] }
}

export async function convertSubmissionToLead(submissionId: string) {
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

  const orgId = profile.default_organization_id

  const { data: submission } = await service
    .from('lead_form_submissions')
    .select('id, data_json, converted_lead_id')
    .eq('id', submissionId)
    .eq('organization_id', orgId)
    .single()

  const rl = await RATE_LIMITS.write(user.id)
  if (!rl.success) return { error: `Too many requests. Try again in ${rl.resetIn}s.` }

  if (!submission) return { error: 'Submission not found' }
  if (submission.converted_lead_id) return { error: 'Already converted' }

  try {
    return await createLeadFromSubmission(service, orgId, submissionId, submission.data_json, profile.id)
  } catch {
    return { error: 'Something went wrong. Please try again.' }
  }
}
