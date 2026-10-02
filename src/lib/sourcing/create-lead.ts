import type { SupabaseClient } from '@supabase/supabase-js'

// One place that turns a sourced or imported company into company + contact + lead, so the
// built-in Companies House job and the import API behave identically.

export type NewSourcedLead = {
  /** Already namespaced by the caller (e.g. 'companies_house', 'import_cqc'). */
  source: string
  /** True only when the sender asserts a limited company / LLP (a PECR corporate subscriber). */
  isLimitedCompany: boolean
  companyName: string
  website?: string | null
  location?: string | null
  industry?: string | null
  contact?: { fullName?: string | null; jobTitle?: string | null; email?: string | null } | null
  activity?: Record<string, unknown>
}

export async function createLeadFromSource(service: SupabaseClient, orgId: string, l: NewSourcedLead): Promise<string | null> {
  const { data: company } = await service
    .from('companies')
    .insert({ organization_id: orgId, name: l.companyName, website: l.website ?? null, location: l.location ?? null, industry: l.industry ?? null })
    .select('id')
    .single()
  if (!company) return null

  const c = l.contact
  const { data: contact } =
    c && (c.fullName || c.email)
      ? await service
          .from('contacts')
          .insert({ organization_id: orgId, company_id: company.id, full_name: c.fullName || 'Unknown', job_title: c.jobTitle ?? null, email: c.email ?? null })
          .select('id')
          .single()
      : { data: null }

  const { data: row } = await service
    .from('leads')
    .insert({
      organization_id: orgId,
      company_id: company.id,
      contact_id: contact?.id ?? null,
      source: l.source,
      status: 'new',
      is_corporate_subscriber: l.isLimitedCompany,
    })
    .select('id')
    .single()
  if (!row) return null

  await service.from('activity_logs').insert({
    organization_id: orgId,
    action: 'created',
    entity_type: 'lead',
    entity_id: row.id,
    after_json: { source: l.source, ...(l.activity ?? {}) },
  })
  return row.id
}
