import type { SupabaseClient } from '@supabase/supabase-js'
import { ukDayBounds, type TodayCounts } from '@/lib/today'
import { DEFAULT_DAILY_CAP_CENTS } from '@/lib/ai-budget'

// The owner's morning brief. Every query is scoped to the given org, so it is safe to run with the
// user's RLS client (the Today page) or the service client (the MCP endpoint, which has already
// resolved the caller's org from their token).

const MAX_ITEMS = 5
const DAY_MS = 24 * 60 * 60_000

export type TodayItem = { id: string; title: string; detail: string | null; href: string }
export type TodaySection = { count: number; items: TodayItem[] }

export type TodayBrief = {
  counts: TodayCounts
  approvals: TodaySection
  replies: TodaySection
  proposals: TodaySection
  hotLeads: TodaySection
  followUps: TodaySection
  problems: TodaySection
  aiSpend: { todayCents: number; last7DaysCents: number; capCents: number }
}

const EMPTY_SECTION: TodaySection = { count: 0, items: [] }
export const EMPTY_BRIEF: TodayBrief = {
  counts: { approvals: 0, replies: 0, proposals: 0, problems: 0 },
  approvals: EMPTY_SECTION, replies: EMPTY_SECTION, proposals: EMPTY_SECTION,
  hotLeads: EMPTY_SECTION, followUps: EMPTY_SECTION, problems: EMPTY_SECTION,
  aiSpend: { todayCents: 0, last7DaysCents: 0, capCents: DEFAULT_DAILY_CAP_CENTS },
}

type LeadJoin = { contacts: { full_name: string | null } | null; companies: { name: string | null } | null } | null

function leadLabel(lead: LeadJoin | undefined): string | null {
  return lead?.contacts?.full_name || lead?.companies?.name || null
}

export async function buildTodayBrief(supabase: SupabaseClient, orgId: string): Promise<TodayBrief> {
  const nowDate = new Date()
  const now = nowDate.toISOString()
  const chaseBefore = new Date(nowDate.getTime() - 3 * DAY_MS).toISOString()
  const since24h = new Date(nowDate.getTime() - DAY_MS).toISOString()
  const since7d = new Date(nowDate.getTime() - 7 * DAY_MS).toISOString()
  const day = ukDayBounds(nowDate)

  const [approvals, replies, proposals, hotLeads, followUps, problems, org, usage] = await Promise.all([
    supabase
      .from('approvals')
      .select('id, title, summary', { count: 'exact' })
      .eq('organization_id', orgId)
      .eq('status', 'pending')
      .or(`expires_at.is.null,expires_at.gt.${now}`)
      .order('created_at', { ascending: true })
      .limit(MAX_ITEMS),
    supabase
      .from('tasks')
      .select('id, title, lead_id, leads(contacts(full_name), companies(name))', { count: 'exact' })
      .eq('organization_id', orgId)
      .in('status', ['todo', 'in_progress'])
      .eq('priority', 'high')
      .like('title', 'Reply from %')
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
      .limit(MAX_ITEMS),
    supabase
      .from('proposals')
      .select('id, title, sent_at, leads(contacts(full_name), companies(name))', { count: 'exact' })
      .eq('organization_id', orgId)
      .eq('status', 'sent')
      .is('decided_at', null)
      .lt('sent_at', chaseBefore)
      .is('deleted_at', null)
      .order('sent_at', { ascending: true })
      .limit(MAX_ITEMS),
    supabase
      .from('leads')
      .select('id, created_at, contacts(full_name), companies(name)', { count: 'exact' })
      .eq('organization_id', orgId)
      .eq('lead_quality', 'hot')
      .eq('status', 'new')
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
      .limit(MAX_ITEMS),
    supabase
      .from('follow_ups')
      .select('id, lead_id, scheduled_for, reason, leads(contacts(full_name), companies(name))', { count: 'exact' })
      .eq('organization_id', orgId)
      .eq('status', 'pending')
      .eq('source', 'automation')
      .gte('scheduled_for', day.start)
      .lt('scheduled_for', day.end)
      .order('scheduled_for', { ascending: true })
      .limit(MAX_ITEMS),
    supabase
      .from('jobs')
      .select('id, job_type, error_message, finished_at', { count: 'exact' })
      .eq('organization_id', orgId)
      .eq('status', 'failed')
      .gte('finished_at', since24h)
      .order('finished_at', { ascending: false })
      .limit(MAX_ITEMS),
    supabase.from('organizations').select('ai_daily_cap_cents').eq('id', orgId).single(),
    // One row per AI call; PostgREST caps a response at 1000 rows, ample for one owner's 7 days.
    supabase
      .from('ai_usage_log')
      .select('cost_usd_cents, created_at')
      .eq('organization_id', orgId)
      .gte('created_at', since7d)
      .limit(1000),
  ])

  let todayCents = 0
  let last7DaysCents = 0
  for (const r of usage.data ?? []) {
    const c = Number(r.cost_usd_cents) || 0
    last7DaysCents += c
    if (r.created_at >= day.start && r.created_at < day.end) todayCents += c
  }

  const approvalsSection: TodaySection = {
    count: approvals.count ?? 0,
    items: (approvals.data ?? []).map((a) => ({ id: a.id, title: a.title, detail: a.summary, href: '/approvals' })),
  }
  const repliesSection: TodaySection = {
    count: replies.count ?? 0,
    items: (replies.data ?? []).map((t) => ({
      id: t.id,
      title: t.title,
      detail: leadLabel(t.leads as unknown as LeadJoin),
      href: t.lead_id ? `/leads/${t.lead_id}` : '/tasks',
    })),
  }
  const proposalsSection: TodaySection = {
    count: proposals.count ?? 0,
    items: (proposals.data ?? []).map((p) => ({
      id: p.id,
      title: p.title,
      detail: [leadLabel(p.leads as unknown as LeadJoin), p.sent_at ? `sent ${new Date(p.sent_at).toLocaleDateString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short' })}` : null].filter(Boolean).join(' · ') || null,
      href: `/proposals/${p.id}`,
    })),
  }
  const hotLeadsSection: TodaySection = {
    count: hotLeads.count ?? 0,
    items: (hotLeads.data ?? []).map((l) => ({
      id: l.id,
      title: leadLabel(l as unknown as LeadJoin) ?? 'Unnamed lead',
      detail: null,
      href: `/leads/${l.id}`,
    })),
  }
  const followUpsSection: TodaySection = {
    count: followUps.count ?? 0,
    items: (followUps.data ?? []).map((f) => ({
      id: f.id,
      title: leadLabel(f.leads as unknown as LeadJoin) ?? 'Unnamed lead',
      detail: new Date(f.scheduled_for).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }),
      href: `/leads/${f.lead_id}`,
    })),
  }
  const problemsSection: TodaySection = {
    count: problems.count ?? 0,
    items: (problems.data ?? []).map((j) => ({ id: j.id, title: j.job_type, detail: j.error_message, href: '/jobs' })),
  }

  return {
    counts: {
      approvals: approvalsSection.count,
      replies: repliesSection.count,
      proposals: proposalsSection.count,
      problems: problemsSection.count,
    },
    approvals: approvalsSection,
    replies: repliesSection,
    proposals: proposalsSection,
    hotLeads: hotLeadsSection,
    followUps: followUpsSection,
    problems: problemsSection,
    aiSpend: { todayCents, last7DaysCents, capCents: org.data?.ai_daily_cap_cents ?? DEFAULT_DAILY_CAP_CENTS },
  }
}
