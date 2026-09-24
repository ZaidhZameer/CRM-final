'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { scoreLeadRule } from '@/lib/scoring'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { requestLeadEnrichment } from '@/lib/automation/events'
import { findOpenLeadIdByEmail, websiteFromEmail } from '@/lib/leads'

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
    const d = submission.data_json as Record<string, string>

    // Repeat enquiry from someone who already has an open lead: link the submission to that
    // lead instead of creating a duplicate (which would also double any follow-ups).
    const existingLeadId = await findOpenLeadIdByEmail(service, orgId, d.email)
    if (existingLeadId) {
      await service
        .from('lead_form_submissions')
        .update({ converted_lead_id: existingLeadId })
        .eq('id', submissionId)
      await service.from('activity_logs').insert({
        organization_id: orgId,
        actor_profile_id: profile.id,
        action: 'updated',
        entity_type: 'lead',
        entity_id: existingLeadId,
        after_json: { source: 'web_form', submission_id: submissionId, repeat_enquiry: true },
      })
      return { success: true, leadId: existingLeadId, duplicate: true }
    }

    const website = d.website || websiteFromEmail(d.email)

    const { data: company } = await service
      .from('companies')
      .insert({
        organization_id: orgId,
        name: d.company_name || d.contact_name || 'Unknown',
        website: website || null,
        industry: d.industry || null,
        location: d.location || null,
        created_by: profile.id,
      })
      .select('id')
      .single()

    const { data: contact } = await service
      .from('contacts')
      .insert({
        organization_id: orgId,
        company_id: company?.id || null,
        full_name: d.contact_name || 'Unknown',
        email: d.email || null,
        phone: d.phone || null,
        job_title: d.job_title || null,
        created_by: profile.id,
      })
      .select('id')
      .single()

    const scoreInput = {
      email: d.email,
      phone: d.phone,
      website: website ?? undefined,
      jobTitle: d.job_title,
      companyName: d.company_name,
      industry: d.industry,
      location: d.location,
    }
    const { score, quality } = scoreLeadRule(scoreInput)

    const { data: lead } = await service
      .from('leads')
      .insert({
        organization_id: orgId,
        company_id: company?.id || null,
        contact_id: contact?.id || null,
        source: 'web_form',
        status: 'new',
        lead_score: score,
        lead_quality: quality,
        created_by: profile.id,
      })
      .select('id')
      .single()

    if (!lead) return { error: 'Failed to create lead' }

    await service
      .from('lead_form_submissions')
      .update({ converted_lead_id: lead.id })
      .eq('id', submissionId)

    await service.from('activity_logs').insert({
      organization_id: orgId,
      actor_profile_id: profile.id,
      action: 'created',
      entity_type: 'lead',
      entity_id: lead.id,
      after_json: { source: 'web_form', submission_id: submissionId },
    })

    // Hand off to n8n for enrichment. Non-blocking; no-ops if unconfigured.
    requestLeadEnrichment({
      organizationId: orgId,
      leadId: lead.id,
      fullName: d.contact_name || null,
      companyName: d.company_name || null,
      website: website || null,
    })

    return { success: true, leadId: lead.id }
  } catch {
    return { error: 'Something went wrong. Please try again.' }
  }
}
