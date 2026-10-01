'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { validate, uuidSchema } from '@/lib/validate'
import { csvRow } from '@/lib/csv'

export type LeadRow = {
  id: string
  source: string | null
  status: string
  lead_score: number
  lead_quality: string
  ai_status: string
  created_at: string
  company_name: string | null
  contact_name: string | null
  contact_email: string | null
  contact_phone: string | null
}

export async function getLeads(params: {
  page: number
  pageSize: number
  search?: string
  status?: string
  quality?: string
  sortBy?: string
  sortDesc?: boolean
}): Promise<{ leads: LeadRow[]; total: number }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/sign-in')

  const service = createServiceClient()

  const { data: profile } = await service
    .from('profiles')
    .select('id, default_organization_id')
    .eq('user_id', user.id)
    .single()

  if (!profile?.default_organization_id) {
    return { leads: [], total: 0 }
  }

  const orgId = profile.default_organization_id
  const { page, pageSize, search, status, quality, sortBy = 'created_at', sortDesc = true } = params

  const validSortColumns = ['created_at', 'lead_score', 'status', 'lead_quality']
  const col = validSortColumns.includes(sortBy) ? sortBy : 'created_at'

  const { data, error } = await service.rpc('search_leads', {
    p_org_id: orgId,
    p_search: search || null,
    p_status: status || null,
    p_quality: quality || null,
    p_sort_by: col,
    p_sort_desc: sortDesc,
    p_limit: pageSize,
    p_offset: page * pageSize,
  })

  if (error) {
    return { leads: [], total: 0 }
  }

  const rows = data ?? []
  const total = rows.length > 0 ? Number(rows[0].total_count) : 0

  const leads: LeadRow[] = rows.map((row: any) => ({
    id: row.id,
    source: row.source,
    status: row.status,
    lead_score: row.lead_score,
    lead_quality: row.lead_quality,
    ai_status: row.ai_status,
    created_at: row.created_at,
    company_name: row.company_name ?? null,
    contact_name: row.contact_name ?? null,
    contact_email: row.contact_email ?? null,
    contact_phone: row.contact_phone ?? null,
  }))

  return { leads, total }
}

export async function inlineUpdateLead(
  leadId: string,
  field: 'status' | 'lead_quality' | 'source',
  value: string
): Promise<{ success?: boolean; error?: string }> {
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
  if (!rl.success) return { error: `Too many updates. Try again in ${rl.resetIn}s.` }

  // Validate field + value
  const ALLOWED: Record<string, string[]> = {
    status: ['new', 'contacted', 'qualified', 'unqualified', 'nurture', 'converted', 'lost'],
    lead_quality: ['hot', 'warm', 'cold'],
    source: [], // any string allowed
  }

  if (!(field in ALLOWED)) return { error: 'Invalid field' }
  if (ALLOWED[field].length > 0 && !ALLOWED[field].includes(value)) return { error: 'Invalid value' }

  try {
    const { data: current } = await service
      .from('leads')
      .select(`${field}, version`)
      .eq('id', leadId)
      .eq('organization_id', profile.default_organization_id)
      .single()

    if (!current) return { error: 'Lead not found' }

    const { error } = await service
      .from('leads')
      .update({ [field]: value, version: current.version + 1 })
      .eq('id', leadId)
      .eq('version', current.version)

    if (error) return { error: 'Update conflict — please refresh' }

    await service.from('activity_logs').insert({
      organization_id: profile.default_organization_id,
      actor_profile_id: profile.id,
      action: 'updated',
      entity_type: 'lead',
      entity_id: leadId,
      before_json: { [field]: (current as any)[field] },
      after_json: { [field]: value },
    })

    return { success: true }
  } catch {
    return { error: 'Something went wrong. Please try again.' }
  }
}

export async function exportLeadsCSV(params: {
  search?: string
  status?: string
  quality?: string
}): Promise<{ csv: string; count: number; total: number; capped: boolean }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/sign-in')

  const service = createServiceClient()

  const { data: profile } = await service
    .from('profiles')
    .select('id, default_organization_id')
    .eq('user_id', user.id)
    .single()

  if (!profile?.default_organization_id) return { csv: '', count: 0, total: 0, capped: false }

  const rl = await RATE_LIMITS.import(user.id)
  if (!rl.success) return { csv: '', count: 0, total: 0, capped: false }

  const orgId = profile.default_organization_id
  const EXPORT_LIMIT = 5000

  // Get total matching count
  let countQuery = service
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', orgId)
    .is('deleted_at', null)

  if (params.status) countQuery = countQuery.eq('status', params.status)
  if (params.quality) countQuery = countQuery.eq('lead_quality', params.quality)

  const { count: totalCount } = await countQuery
  const total = totalCount ?? 0

  let query = service
    .from('leads')
    .select(`
      id, source, status, lead_score, lead_quality, ai_status,
      pipeline_stage, last_contacted_at, next_follow_up_at,
      created_at, updated_at,
      companies(name, website, industry, size_band, location),
      contacts(full_name, email, phone, job_title, linkedin_url, is_decision_maker)
    `)
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(EXPORT_LIMIT)

  if (params.status) query = query.eq('status', params.status)
  if (params.quality) query = query.eq('lead_quality', params.quality)

  const { data } = await query

  if (!data || data.length === 0) return { csv: '', count: 0, total, capped: false }

  // Build CSV
  const headers = [
    'Company Name', 'Website', 'Industry', 'Size', 'Location',
    'Contact Name', 'Email', 'Phone', 'Job Title', 'LinkedIn',
    'Decision Maker', 'Source', 'Status', 'Quality', 'Score',
    'AI Status', 'Pipeline Stage', 'Last Contacted', 'Next Follow-up',
    'Created', 'Updated',
  ]

  const rows = data.map((r: any) => {
    const co = r.companies
    const ct = r.contacts
    return [
      co?.name ?? '', co?.website ?? '', co?.industry ?? '', co?.size_band ?? '', co?.location ?? '',
      ct?.full_name ?? '', ct?.email ?? '', ct?.phone ?? '', ct?.job_title ?? '', ct?.linkedin_url ?? '',
      ct?.is_decision_maker ? 'Yes' : 'No',
      r.source ?? '', r.status, r.lead_quality, r.lead_score,
      r.ai_status, r.pipeline_stage ?? '',
      r.last_contacted_at ? new Date(r.last_contacted_at).toLocaleDateString() : '',
      r.next_follow_up_at ? new Date(r.next_follow_up_at).toLocaleDateString() : '',
      new Date(r.created_at).toLocaleDateString(),
      new Date(r.updated_at).toLocaleDateString(),
    ]
  })

  const csv = [csvRow(headers), ...rows.map(csvRow)].join('\n')

  // Log export activity
  await service.from('activity_logs').insert({
    organization_id: orgId,
    actor_profile_id: profile.id,
    action: 'exported',
    entity_type: 'leads',
    after_json: { count: data.length, filters: params },
  })

  return { csv, count: data.length, total, capped: total > EXPORT_LIMIT }
}

export async function getLeadMetrics(): Promise<{
  newLeads: number
  qualifiedLeads: number
  hotLeads: number
  avgScore: number
}> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/sign-in')

  const service = createServiceClient()

  const { data: profile } = await service
    .from('profiles')
    .select('id, default_organization_id')
    .eq('user_id', user.id)
    .single()

  if (!profile?.default_organization_id) {
    return { newLeads: 0, qualifiedLeads: 0, hotLeads: 0, avgScore: 0 }
  }

  const orgId = profile.default_organization_id
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const [newRes, qualRes, hotRes, scoreRes] = await Promise.all([
    service
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .is('deleted_at', null)
      .eq('status', 'new'),
    service
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .is('deleted_at', null)
      .eq('status', 'qualified'),
    service
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .is('deleted_at', null)
      .eq('lead_quality', 'hot'),
    service
      .from('leads')
      .select('lead_score')
      .eq('organization_id', orgId)
      .is('deleted_at', null),
  ])

  const scores = (scoreRes.data ?? []).map((r: any) => Number(r.lead_score))
  const avgScore = scores.length > 0
    ? Math.round(scores.reduce((a: number, b: number) => a + b, 0) / scores.length)
    : 0

  return {
    newLeads: newRes.count ?? 0,
    qualifiedLeads: qualRes.count ?? 0,
    hotLeads: hotRes.count ?? 0,
    avgScore,
  }
}
