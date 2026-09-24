import type { SupabaseClient } from '@supabase/supabase-js'
import { scoreLeadRule } from '@/lib/scoring'
import { requestLeadEnrichment } from '@/lib/automation/events'
import { findOpenLeadIdByEmail, websiteFromEmail } from '@/lib/leads'

export type IntakeResult = { success?: boolean; leadId?: string; duplicate?: boolean; error?: string }

/**
 * Turns a lead-form submission into a lead: dedupes against open leads, creates company,
 * contact and lead, links the submission, logs it, and hands the lead to enrichment.
 * Used by the public form (instantly, actorProfileId = null) and the dashboard button.
 */
export async function createLeadFromSubmission(
  service: SupabaseClient,
  orgId: string,
  submissionId: string,
  submissionData: unknown,
  actorProfileId: string | null
): Promise<IntakeResult> {
  const d = submissionData as Record<string, string>

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
      actor_profile_id: actorProfileId,
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
      created_by: actorProfileId,
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
      created_by: actorProfileId,
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
      created_by: actorProfileId,
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
    actor_profile_id: actorProfileId,
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
}
