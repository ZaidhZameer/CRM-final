'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { runBasicResearch, runStandardResearch, estimateCostCents } from '@/lib/ai/openai'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { validate, uuidSchema } from '@/lib/validate'
import { getAiBudget, budgetMessage } from '@/lib/ai-budget'

export async function runAIResearch(leadId: string, tier: 'basic' | 'standard' = 'basic') {
  // Validate input
  const idCheck = validate(uuidSchema, leadId)
  if (idCheck.error) return { error: 'Invalid lead ID' }
  if (tier !== 'basic' && tier !== 'standard') return { error: 'Invalid tier' }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/sign-in')

  // Rate limit AI requests
  const rl = await RATE_LIMITS.aiResearch(user.id)
  if (!rl.success) return { error: `Too many AI requests. Try again in ${rl.resetIn}s.` }

  const service = createServiceClient()

  const { data: profile } = await service
    .from('profiles')
    .select('id, default_organization_id')
    .eq('user_id', user.id)
    .single()

  if (!profile?.default_organization_id) {
    return { error: 'No active organization' }
  }

  const orgId = profile.default_organization_id

  // Check daily AI cap
  const budget = await getAiBudget(service, orgId)
  if (budget.exhausted) {
    return { error: `${budgetMessage(budget)}. Try again tomorrow.` }
  }

  // Get lead + company + contact data
  const { data: lead } = await service
    .from('leads')
    .select(`
      id, ai_status,
      companies(name, website, industry, location),
      contacts(full_name, email, job_title)
    `)
    .eq('id', leadId)
    .eq('organization_id', orgId)
    .single()

  if (!lead) return { error: 'Lead not found' }

  // Mark as running
  await service
    .from('leads')
    .update({ ai_status: 'running' })
    .eq('id', leadId)

  // Create pending research report
  const { data: report } = await service
    .from('research_reports')
    .insert({
      organization_id: orgId,
      lead_id: leadId,
      tier,
      status: 'running',
      model: tier === 'basic' ? 'gpt-4o-mini' : 'gpt-4o',
    })
    .select('id')
    .single()

  if (!report) return { error: 'Failed to create research report' }

  try {
    const company = (lead as any).companies
    const contact = (lead as any).contacts

    const input = {
      companyName: company?.name,
      website: company?.website,
      contactName: contact?.full_name,
      email: contact?.email,
      jobTitle: contact?.job_title,
      industry: company?.industry,
      location: company?.location,
    }

    const result = tier === 'basic'
      ? await runBasicResearch(input)
      : await runStandardResearch(input)

    const costCents = estimateCostCents(result.model, result.promptTokens, result.completionTokens)

    // Update research report
    await service
      .from('research_reports')
      .update({
        company_summary: result.output.company_summary,
        website_analysis: result.output.website_analysis,
        pain_points_json: result.output.pain_points,
        recommended_offer: result.output.recommended_offer,
        outreach_angle: result.output.outreach_angle,
        next_best_action: result.output.next_best_action,
        lead_score: result.output.lead_score,
        confidence_score: result.output.confidence_score,
        model: result.model,
        status: 'completed',
      })
      .eq('id', report.id)

    // Update lead score and AI status
    await service
      .from('leads')
      .update({
        ai_status: 'completed',
        lead_score: result.output.lead_score,
        lead_quality: result.output.lead_quality,
      })
      .eq('id', leadId)

    // Log AI usage
    await service
      .from('ai_usage_log')
      .insert({
        organization_id: orgId,
        lead_id: leadId,
        model: result.model,
        tier,
        prompt_tokens: result.promptTokens,
        completion_tokens: result.completionTokens,
        cost_usd_cents: costCents,
        latency_ms: result.latencyMs,
        status: 'success',
      })

    // Activity log
    await service.from('activity_logs').insert({
      organization_id: orgId,
      actor_profile_id: profile.id,
      entity_type: 'lead',
      entity_id: leadId,
      action: 'researched',
      after_json: { tier, model: result.model, score: result.output.lead_score },
    })

    return { success: true, score: result.output.lead_score, quality: result.output.lead_quality }
  } catch (err: any) {
    // Mark as failed
    await service
      .from('research_reports')
      .update({ status: 'failed', error_message: err.message })
      .eq('id', report.id)

    await service
      .from('leads')
      .update({ ai_status: 'failed' })
      .eq('id', leadId)

    return { error: `AI research failed: ${err.message}` }
  }
}
