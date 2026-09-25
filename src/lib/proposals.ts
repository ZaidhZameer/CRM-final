import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AUTOMATION_SECRET_HEADER } from '@/lib/automation/secret'
import type { ProposalDraftRequested, ProposalDrafted } from '@/lib/automation/contract'
import { getAiBudget, budgetMessage } from '@/lib/ai-budget'

// Proposals: AI drafts the words, a human sets the price.
// Spec: Obsidian SALES-OS/INTERNAL/FLOWLEAD_PROPOSALS_SPEC_2026-09-25.md

export const PROPOSAL_JOB_TYPE = 'proposal.draft'
export const PRICE_PLACEHOLDER = '[pricing set separately]'

// Money-looking amounts: £1,200 / $500.00 / €3k / 2,400 GBP / 1.5k pounds / 900 per month (with a currency).
const MONEY = new RegExp(
  [
    String.raw`[£$€]\s?\d[\d,]*(?:\.\d+)?(?:\s?[kKmM]\b)?(?:\s?\+\s?VAT\b)?`,
    String.raw`\b\d[\d,]*(?:\.\d+)?(?:\s?[kKmM])?\s?(?:GBP|USD|EUR|pounds?|dollars?|euros?)\b`,
  ].join('|'),
  'g'
)

/** Replaces any money amount the model wrote with a placeholder: pricing is human-only. */
export function stripMoney(text: string): string {
  return text.replace(MONEY, PRICE_PLACEHOLDER).replace(new RegExp(`(${escapeRe(PRICE_PLACEHOLDER)})(\\s*[-–to]+\\s*\\1)+`, 'g'), PRICE_PLACEHOLDER)
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export type ProposalSections = ProposalDrafted['payload']['sections']

/** Cleans every AI-written section before it is stored. Exported for tests. */
export function sanitizeSections(s: ProposalSections): ProposalSections {
  const t = (x: string) => stripMoney(x.replace(/\r/g, '').trim())
  return {
    summary: t(s.summary),
    situation: t(s.situation),
    solution: t(s.solution),
    scope: s.scope.map(t).filter(Boolean),
    timeline: t(s.timeline),
    assumptions: s.assumptions.map(t).filter(Boolean),
    next_steps: t(s.next_steps),
  }
}

type RequestInput = { orgId: string; leadId: string; meetingId?: string | null; brief?: string | null; actorProfileId: string | null }

/**
 * Creates a draft proposal and asks the engine to write it. Returns the proposal id, or an
 * error the UI can show. The proposal row exists even if the engine is down (it can be written
 * by hand in the editor).
 */
export async function requestProposalDraft(service: SupabaseClient, input: RequestInput): Promise<{ proposalId?: string; error?: string }> {
  const { data: lead } = await service
    .from('leads')
    .select('id, companies(name), contacts(full_name, job_title)')
    .eq('id', input.leadId)
    .eq('organization_id', input.orgId)
    .is('deleted_at', null)
    .single()
  if (!lead) return { error: 'Lead not found' }
  const company = (lead.companies ?? null) as unknown as { name: string | null } | null
  const contact = (lead.contacts ?? null) as unknown as { full_name: string | null; job_title: string | null } | null

  const { data: proposal, error } = await service
    .from('proposals')
    .insert({
      organization_id: input.orgId,
      lead_id: input.leadId,
      meeting_id: input.meetingId ?? null,
      title: `Proposal for ${company?.name ?? contact?.full_name ?? 'client'}`.slice(0, 200),
      brief: input.brief?.slice(0, 4000) || null,
      created_by: input.actorProfileId,
      valid_until: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString().slice(0, 10),
    })
    .select('id')
    .single()
  if (error || !proposal) return { error: 'Could not create the proposal' }

  const url = process.env.N8N_PROPOSAL_DRAFT_URL
  const secret = process.env.AUTOMATION_SHARED_SECRET
  if (!url || !secret) return { proposalId: proposal.id, error: 'AI drafting is not configured; write it in the editor.' }

  const budget = await getAiBudget(service, input.orgId)
  if (budget.exhausted) return { proposalId: proposal.id, error: `${budgetMessage(budget)}. Write it in the editor or try tomorrow.` }

  const [{ data: report }, { data: meeting }, { data: submission }, { data: ctx }, { data: org }] = await Promise.all([
    service.from('research_reports').select('company_summary, pain_points_json, recommended_offer').eq('lead_id', input.leadId).eq('status', 'completed').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    input.meetingId
      ? service.from('meetings').select('title, notes, ai_summary').eq('id', input.meetingId).eq('organization_id', input.orgId).maybeSingle()
      : service.from('meetings').select('title, notes, ai_summary').eq('lead_id', input.leadId).order('start_time', { ascending: false }).limit(1).maybeSingle(),
    service.from('lead_form_submissions').select('data_json').eq('converted_lead_id', input.leadId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    // The agency's own context (company_id null = the org itself).
    service.from('client_context').select('services, brand_voice, past_work, do_rules, dont_rules').eq('organization_id', input.orgId).is('company_id', null).is('deleted_at', null).maybeSingle(),
    service.from('organizations').select('name').eq('id', input.orgId).single(),
  ])
  const form = (submission?.data_json ?? null) as Record<string, string> | null
  const pain = report?.pain_points_json as unknown

  const event: ProposalDraftRequested = {
    event_id: randomUUID(),
    event_type: 'proposal.draft.requested',
    organization_id: input.orgId,
    subject_id: proposal.id,
    payload: {
      lead_id: input.leadId,
      brief: input.brief?.slice(0, 4000) || null,
      contact: { full_name: contact?.full_name ?? null, company_name: company?.name ?? null, job_title: contact?.job_title ?? null },
      enquiry: (form?.message ?? form?.notes ?? null)?.slice(0, 5000) ?? null,
      research: report
        ? {
            company_summary: report.company_summary,
            pain_points: Array.isArray(pain) ? (pain as unknown[]).map(String).slice(0, 50) : null,
            recommended_offer: report.recommended_offer,
          }
        : null,
      meeting: meeting ? { title: meeting.title, notes: meeting.notes, ai_summary: meeting.ai_summary } : null,
      agency: {
        name: org?.name ?? null,
        services: ctx?.services ?? null,
        brand_voice: ctx?.brand_voice ?? null,
        past_work: ctx?.past_work ?? null,
        do_rules: ctx?.do_rules ?? null,
        dont_rules: ctx?.dont_rules ?? null,
      },
    },
  }

  const jobKey = { event_id: event.event_id, organization_id: input.orgId }
  await service.from('jobs').insert({ ...jobKey, job_type: PROPOSAL_JOB_TYPE, subject_type: 'proposal', subject_id: proposal.id, status: 'queued' })
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [AUTOMATION_SECRET_HEADER]: secret },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`engine rejected (HTTP ${res.status})`)
    await service.from('jobs').update({ status: 'running', started_at: new Date().toISOString(), attempts: 1 }).match(jobKey)
    return { proposalId: proposal.id }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error'
    await service.from('jobs').update({ status: 'failed', finished_at: new Date().toISOString(), error_message: `could not request draft: ${message}` }).match(jobKey)
    return { proposalId: proposal.id, error: 'The AI drafter is unavailable right now; you can write it in the editor.' }
  }
}
