import type { SupabaseClient } from '@supabase/supabase-js'
import { getOfficers, searchCompanies, type SourcedCompany } from './companies-house'
import { displayCompanyName, normaliseCompanyName } from './names'
import { requestLeadEnrichment } from '@/lib/automation/events'

// Daily lead sourcing from Companies House (spec: FLOWLEAD_LEAD_SOURCING_SPEC_2026-10-01.md).
// Everything is opt-in per org (sourcing_settings.enabled, default OFF) and capped per day.
// It only CREATES LEADS (marked corporate subscribers: every result is a limited company).
// It never sends anything; outreach goes through drafts and the Approval Inbox.

export type SourcingSummary =
  | { ran: false; reason: 'disabled' | 'no_sic_codes' | 'missing_key' | 'daily_cap_reached' | 'search_failed' }
  | { ran: true; found: number; created: number; skippedDuplicate: number; stoppedEarly?: 'rate_limited' }

export type SourcingDeps = {
  search?: typeof searchCompanies
  officers?: typeof getOfficers
  now?: () => Date
  /** Hand a new lead to enrichment (research and scoring). Defaults to the real n8n request. */
  enrich?: typeof requestLeadEnrichment
}

const yearsAgo = (d: Date, years: number) => {
  const x = new Date(d)
  x.setUTCFullYear(x.getUTCFullYear() - years)
  return x.toISOString().slice(0, 10)
}

export async function runSourcingForOrg(service: SupabaseClient, orgId: string, deps: SourcingDeps = {}): Promise<SourcingSummary> {
  const search = deps.search ?? searchCompanies
  const officers = deps.officers ?? getOfficers
  const enrich = deps.enrich ?? requestLeadEnrichment
  const now = (deps.now ?? (() => new Date()))()

  const { data: s } = await service
    .from('sourcing_settings')
    .select('enabled, campaign, sic_codes, location, min_age_years, max_age_years, daily_cap')
    .eq('organization_id', orgId)
    .maybeSingle()
  if (!s?.enabled) return { ran: false, reason: 'disabled' }
  if (!s.sic_codes?.length) return { ran: false, reason: 'no_sic_codes' }

  const { count: createdToday } = await service
    .from('sourced_companies')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', orgId)
    .eq('status', 'lead_created')
    .gte('found_at', new Date(now.getTime() - 24 * 60 * 60_000).toISOString())
  const remaining = s.daily_cap - (createdToday ?? 0)
  if (remaining <= 0) return { ran: false, reason: 'daily_cap_reached' }

  const found = await search({
    sicCodes: s.sic_codes,
    location: s.location ?? undefined,
    incorporatedFrom: yearsAgo(now, s.max_age_years),
    incorporatedTo: yearsAgo(now, s.min_age_years),
    maxResults: Math.min(200, Math.max(40, remaining * 8)),
  })
  if (!found.ok) return { ran: false, reason: found.error.kind === 'missing_key' ? 'missing_key' : 'search_failed' }

  // Dedupe: by company number (everything ever found) and by name against the org's existing companies.
  const [{ data: seen }, { data: existing }] = await Promise.all([
    service.from('sourced_companies').select('company_number').eq('organization_id', orgId),
    service.from('companies').select('name').eq('organization_id', orgId).is('deleted_at', null).limit(5000),
  ])
  const seenNumbers = new Set((seen ?? []).map((r: { company_number: string }) => r.company_number))
  const existingNames = new Set((existing ?? []).map((r: { name: string }) => normaliseCompanyName(r.name)))

  let created = 0
  let skippedDuplicate = 0
  let stoppedEarly: 'rate_limited' | undefined

  for (const c of found.data) {
    if (created >= remaining) break
    if (seenNumbers.has(c.company_number)) continue

    // Claim first (unique per org+number): a concurrent run can't process the same company.
    const dup = existingNames.has(normaliseCompanyName(c.name))
    const { data: claim, error: claimError } = await service
      .from('sourced_companies')
      .insert({
        organization_id: orgId,
        company_number: c.company_number,
        name: displayCompanyName(c.name),
        campaign: s.campaign,
        sic_codes: c.sic_codes,
        incorporated_on: c.incorporated_on,
        address: c.address,
        status: dup ? 'skipped_duplicate' : 'found',
      })
      .select('id')
      .single()
    if (claimError || !claim) continue
    seenNumbers.add(c.company_number)
    if (dup) {
      skippedDuplicate++
      continue
    }

    const o = await officers(c.company_number)
    if (!o.ok && o.error.kind === 'rate_limited') {
      stoppedEarly = 'rate_limited'
      await service.from('sourced_companies').delete().eq('id', claim.id) // retry tomorrow
      break
    }
    const directors = o.ok ? o.data : []

    const leadId = await createSourcedLead(service, orgId, s.campaign, { ...c, directors })
    if (!leadId) {
      await service.from('sourced_companies').update({ status: 'error', note: 'could not create lead' }).eq('id', claim.id)
      continue
    }
    await service.from('sourced_companies').update({ status: 'lead_created', lead_id: leadId, directors }).eq('id', claim.id)
    existingNames.add(normaliseCompanyName(c.name))
    created++

    // Research and score (budget-capped inside). No website known yet: the research step looks for it.
    enrich({ organizationId: orgId, leadId, fullName: directors[0]?.name ?? null, companyName: displayCompanyName(c.name), website: null })
  }

  return { ran: true, found: found.data.length, created, skippedDuplicate, ...(stoppedEarly ? { stoppedEarly } : {}) }
}

async function createSourcedLead(
  service: SupabaseClient,
  orgId: string,
  campaign: string,
  c: SourcedCompany
): Promise<string | null> {
  const name = displayCompanyName(c.name)
  const { data: company } = await service
    .from('companies')
    .insert({ organization_id: orgId, name, location: c.address || null, industry: c.sic_codes.join(', ') || null })
    .select('id')
    .single()
  if (!company) return null

  const lead = c.directors[0]
  const { data: contact } = lead
    ? await service
        .from('contacts')
        .insert({ organization_id: orgId, company_id: company.id, full_name: lead.name, job_title: lead.role })
        .select('id')
        .single()
    : { data: null }

  const { data: row } = await service
    .from('leads')
    .insert({
      organization_id: orgId,
      company_id: company.id,
      contact_id: contact?.id ?? null,
      source: campaign === 'agencies' ? 'companies_house_agencies' : 'companies_house',
      status: 'new',
      // Every Companies House result is a limited company or LLP: a PECR corporate subscriber.
      is_corporate_subscriber: true,
    })
    .select('id')
    .single()
  if (!row) return null

  await service.from('activity_logs').insert({
    organization_id: orgId,
    action: 'created',
    entity_type: 'lead',
    entity_id: row.id,
    after_json: { source: 'companies_house', company_number: c.company_number, campaign },
  })
  return row.id
}

/** Runs sourcing for every org that switched it on. One org failing never stops the others. */
export async function runSourcingForAllOrgs(service: SupabaseClient, deps: SourcingDeps = {}) {
  const { data: orgs } = await service.from('sourcing_settings').select('organization_id').eq('enabled', true)
  const results: Record<string, SourcingSummary | { ran: false; reason: 'error' }> = {}
  for (const o of (orgs ?? []) as { organization_id: string }[]) {
    results[o.organization_id] = await runSourcingForOrg(service, o.organization_id, deps).catch((err) => {
      console.error('[sourcing] org run failed', o.organization_id, err instanceof Error ? err.message : err)
      return { ran: false as const, reason: 'error' as const }
    })
  }
  return results
}
