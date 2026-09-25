'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { requestProposalDraft, stripMoney, type ProposalSections } from '@/lib/proposals'
import { scheduledSendTime } from '@/lib/follow-ups'
import { moveLeadStage } from '../pipeline/actions'

// Proposals UI actions. Reads and edits go through the user's RLS client (staff roles only);
// the price is entered here by a human and the DB refuses approval without it.
// Spec: Obsidian SALES-OS/INTERNAL/FLOWLEAD_PROPOSALS_SPEC_2026-09-25.md

export type ProposalListRow = {
  id: string
  title: string
  status: string
  price_amount: number | null
  currency: string
  price_type: string
  company: string | null
  lead_id: string
  created_at: string
  sent_at: string | null
}

export type ProposalDetail = ProposalListRow & {
  sections: ProposalSections
  brief: string | null
  price_notes: string | null
  valid_until: string | null
  share_token: string
  version: number
  approval_id: string | null
  drafted_by_ai: boolean
  drafting: boolean
  decline_reason: string | null
}

const EMPTY_SECTIONS: ProposalSections = { summary: '', situation: '', solution: '', scope: [], timeline: '', assumptions: [], next_steps: '' }

async function ctx() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/sign-in')
  const service = createServiceClient()
  const { data: profile } = await service.from('profiles').select('id, default_organization_id').eq('user_id', user.id).single()
  return { supabase, service, profileId: profile?.id ?? null, orgId: profile?.default_organization_id ?? null }
}

export async function getProposals(): Promise<{ proposals: ProposalListRow[] }> {
  const { supabase, orgId } = await ctx()
  if (!orgId) return { proposals: [] }
  const { data } = await supabase
    .from('proposals')
    .select('id, title, status, price_amount, currency, price_type, lead_id, created_at, sent_at, leads(companies(name))')
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(100)
  return {
    proposals: (data ?? []).map((p) => ({
      id: p.id, title: p.title, status: p.status, price_amount: p.price_amount === null ? null : Number(p.price_amount),
      currency: p.currency, price_type: p.price_type, lead_id: p.lead_id, created_at: p.created_at, sent_at: p.sent_at,
      company: ((p.leads as unknown as { companies: { name: string | null } | null } | null)?.companies?.name) ?? null,
    })),
  }
}

export async function getProposal(id: string): Promise<{ proposal?: ProposalDetail; error?: string }> {
  const { supabase, service, orgId } = await ctx()
  if (!orgId) return { error: 'No organization' }
  const { data: p } = await supabase
    .from('proposals')
    .select('*, leads(companies(name))')
    .eq('id', id)
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .maybeSingle()
  if (!p) return { error: 'Proposal not found' }
  const content = (p.content_json ?? {}) as { sections?: ProposalSections; drafted_by?: string }
  const { count: drafting } = await service
    .from('jobs')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', orgId)
    .eq('subject_id', id)
    .eq('job_type', 'proposal.draft')
    .in('status', ['queued', 'running'])
  return {
    proposal: {
      id: p.id, title: p.title, status: p.status, price_amount: p.price_amount === null ? null : Number(p.price_amount),
      currency: p.currency, price_type: p.price_type, lead_id: p.lead_id, created_at: p.created_at, sent_at: p.sent_at,
      company: ((p.leads as unknown as { companies: { name: string | null } | null } | null)?.companies?.name) ?? null,
      sections: { ...EMPTY_SECTIONS, ...(content.sections ?? {}) },
      brief: p.brief, price_notes: p.price_notes, valid_until: p.valid_until, share_token: p.share_token,
      version: p.version, approval_id: p.approval_id, drafted_by_ai: content.drafted_by === 'ai',
      drafting: (drafting ?? 0) > 0, decline_reason: p.decline_reason,
    },
  }
}

/** "Draft proposal" on a lead: creates the draft and asks the AI to write it. */
export async function draftProposal(leadId: string, brief?: string): Promise<{ proposalId?: string; error?: string }> {
  const { service, orgId, profileId } = await ctx()
  if (!orgId) return { error: 'No organization' }
  const res = await requestProposalDraft(service, { orgId, leadId, brief: brief ?? null, actorProfileId: profileId })
  revalidatePath('/proposals')
  return res
}

export type ProposalEdit = {
  title: string
  sections: ProposalSections
  price_amount: number | null
  currency: string
  price_type: string
  price_notes: string | null
  valid_until: string | null
}

/** Saves edits to a draft (optimistic version check). Anything past draft is read-only. */
export async function saveProposal(id: string, edit: ProposalEdit, version: number): Promise<{ version?: number; error?: string }> {
  const { supabase, orgId } = await ctx()
  if (!orgId) return { error: 'No organization' }
  const price = edit.price_amount === null || Number.isNaN(edit.price_amount) ? null : Math.round(edit.price_amount * 100) / 100
  if (price !== null && (price < 0 || price > 10_000_000)) return { error: 'Price looks wrong.' }
  const clean = (s: string, n: number) => s.replace(/\r/g, '').slice(0, n)
  const { data, error } = await supabase
    .from('proposals')
    .update({
      title: clean(edit.title, 200).replace(/\n/g, ' ') || 'Proposal',
      content_json: {
        sections: {
          summary: clean(edit.sections.summary, 6000), situation: clean(edit.sections.situation, 6000),
          solution: clean(edit.sections.solution, 6000), timeline: clean(edit.sections.timeline, 6000),
          next_steps: clean(edit.sections.next_steps, 6000),
          scope: edit.sections.scope.map((x) => clean(x, 600)).filter((x) => x.trim()).slice(0, 20),
          assumptions: edit.sections.assumptions.map((x) => clean(x, 600)).filter((x) => x.trim()).slice(0, 15),
        },
        edited_by: 'human',
      },
      price_amount: price,
      currency: ['GBP', 'USD', 'EUR'].includes(edit.currency) ? edit.currency : 'GBP',
      price_type: edit.price_type === 'monthly' ? 'monthly' : 'one_off',
      price_notes: edit.price_notes ? clean(edit.price_notes, 2000) : null,
      valid_until: edit.valid_until || null,
      version: version + 1,
    })
    .eq('id', id)
    .eq('organization_id', orgId)
    .eq('status', 'draft')
    .eq('version', version)
    .select('version')
  if (error) return { error: 'Could not save. You may not have permission to edit proposals.' }
  if (!data?.length) return { error: 'This proposal changed elsewhere or is no longer a draft. Refresh and try again.' }
  revalidatePath(`/proposals/${id}`)
  return { version: data[0].version }
}

/** Human approval. Requires a price (also enforced by the DB). */
export async function approveProposal(id: string): Promise<{ error?: string }> {
  const { supabase, service, orgId } = await ctx()
  if (!orgId) return { error: 'No organization' }
  const { data: p } = await supabase.from('proposals').select('id, status, price_amount, approval_id, title, lead_id, content_json').eq('id', id).eq('organization_id', orgId).maybeSingle()
  if (!p) return { error: 'Proposal not found' }
  if (p.status !== 'draft') return { error: 'Only a draft can be approved.' }
  if (!p.price_amount || Number(p.price_amount) <= 0) return { error: 'Set a price first. The AI never prices proposals.' }
  // Guard against a money amount typed by hand into the wording differing from the price field.
  if (stripMoney(JSON.stringify(p.content_json ?? {})) !== JSON.stringify(p.content_json ?? {})) {
    return { error: 'The wording contains a money amount. Put pricing only in the price field (it is shown on its own).' }
  }

  let approvalId = p.approval_id
  if (!approvalId) {
    // Written by hand without the AI: still record the human decision in the Approval Inbox.
    const { data: a } = await service
      .from('approvals')
      .insert({ organization_id: orgId, action_type: 'send_proposal', tier: 'always_human', subject_type: 'lead', subject_id: p.lead_id, title: p.title, payload_json: { proposal_id: id, editor_url: `/proposals/${id}` } })
      .select('id')
      .single()
    approvalId = a?.id ?? null
    if (approvalId) await service.from('proposals').update({ approval_id: approvalId }).eq('id', id)
  }
  if (!approvalId) return { error: 'Could not record the approval.' }

  const { data: a } = await service.from('approvals').select('version, status').eq('id', approvalId).single()
  if (a?.status === 'pending') {
    const { error: rpcError } = await supabase.rpc('decide_approval', { p_approval_id: approvalId, p_decision: 'approved', p_expected_version: a.version, p_note: null, p_edited_payload: null })
    if (rpcError) return { error: rpcError.message === 'not_allowed' ? 'You do not have permission to approve proposals.' : 'Could not record the approval.' }
  }
  const { error } = await supabase.from('proposals').update({ status: 'approved' }).eq('id', id).eq('status', 'draft')
  if (error) return { error: 'Could not approve (is the price set?).' }
  revalidatePath(`/proposals/${id}`)
  revalidatePath('/approvals')
  return {}
}

/** The owner sent it (link or PDF). Moves the lead to "proposal sent" with the price as deal value. */
export async function markProposalSent(id: string): Promise<{ error?: string }> {
  const { supabase, service, orgId, profileId } = await ctx()
  if (!orgId) return { error: 'No organization' }
  const { data: p } = await supabase.from('proposals').select('id, status, lead_id, price_amount, price_type, valid_until, approval_id, title').eq('id', id).eq('organization_id', orgId).maybeSingle()
  if (!p || p.status !== 'approved') return { error: 'Approve the proposal before marking it sent.' }

  const { error } = await supabase.from('proposals').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', id).eq('status', 'approved')
  if (error) return { error: 'Could not update the proposal.' }
  if (p.approval_id) await service.from('approvals').update({ status: 'executed' }).eq('id', p.approval_id).eq('status', 'approved')

  const { data: lead } = await service.from('leads').select('version, pipeline_stage').eq('id', p.lead_id).single()
  if (lead && !['proposal_sent', 'negotiation', 'won'].includes(lead.pipeline_stage ?? '')) {
    const annual = p.price_type === 'monthly' ? Number(p.price_amount) * 12 : Number(p.price_amount)
    await moveLeadStage(p.lead_id, 'proposal_sent', lead.version, { value: annual, closeDate: p.valid_until ?? undefined })
  }
  // Nudge the owner if nothing has come back in three business days.
  const due = scheduledSendTime(new Date(), 1)
  await service.from('tasks').insert({
    organization_id: orgId,
    lead_id: p.lead_id,
    title: `Check in on proposal: ${p.title}`.slice(0, 200),
    description: 'Sent three business days ago with no decision recorded yet. A short personal check-in usually helps.',
    priority: 'medium',
    status: 'todo',
    due_at: due?.toISOString() ?? new Date(Date.now() + 3 * 86_400_000).toISOString(),
    assigned_to: profileId,
  })
  revalidatePath(`/proposals/${id}`)
  return {}
}

export async function recordProposalOutcome(id: string, outcome: 'accepted' | 'declined', reason?: string): Promise<{ error?: string }> {
  const { supabase, service, orgId } = await ctx()
  if (!orgId) return { error: 'No organization' }
  const { data: p } = await supabase.from('proposals').select('id, status, lead_id').eq('id', id).eq('organization_id', orgId).maybeSingle()
  if (!p || !['sent', 'approved'].includes(p.status)) return { error: 'Only a sent proposal can be accepted or declined.' }
  const { error } = await supabase
    .from('proposals')
    .update({ status: outcome, decided_at: new Date().toISOString(), decline_reason: outcome === 'declined' ? (reason ?? '').slice(0, 2000) || null : null })
    .eq('id', id)
  if (error) return { error: 'Could not record the outcome.' }
  const { data: lead } = await service.from('leads').select('version').eq('id', p.lead_id).single()
  if (lead) await moveLeadStage(p.lead_id, outcome === 'accepted' ? 'won' : 'lost', lead.version)
  revalidatePath(`/proposals/${id}`)
  return {}
}

export async function withdrawProposal(id: string): Promise<{ error?: string }> {
  const { supabase, service, orgId } = await ctx()
  if (!orgId) return { error: 'No organization' }
  const { data: p } = await supabase.from('proposals').select('approval_id, status').eq('id', id).eq('organization_id', orgId).maybeSingle()
  if (!p || ['accepted', 'declined', 'withdrawn'].includes(p.status)) return { error: 'This proposal can no longer be withdrawn.' }
  const { error } = await supabase.from('proposals').update({ status: 'withdrawn' }).eq('id', id)
  if (error) return { error: 'Could not withdraw.' }
  if (p.approval_id) await service.from('approvals').update({ status: 'cancelled' }).eq('id', p.approval_id).eq('status', 'pending')
  revalidatePath('/proposals')
  return {}
}
