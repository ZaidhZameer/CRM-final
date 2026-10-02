import type { SupabaseClient } from '@supabase/supabase-js'
import { createLeadFromSource } from './create-lead'
import { displayCompanyName, normaliseCompanyName } from './names'
import { findOpenLeadIdByEmail } from '@/lib/leads'

// The official door for leads from ANY source (the built-in Companies House job, an old Python
// lead-gen engine, a CQC adapter, a Crawl4AI contact-page crawler...). Every lead goes through
// the same rules, so a new source can never weaken UK email compliance.

export type ImportLeadInput = {
  company_name: string
  company_number?: string | null
  website?: string | null
  address?: string | null
  industry?: string | null
  /** The SENDER asserts this is a limited company/LLP. Only then is the lead marked a PECR corporate subscriber. */
  is_limited_company?: boolean
  contact?: { full_name?: string | null; job_title?: string | null; email?: string | null } | null
}

export type ImportOutcome =
  | { index: number; status: 'created'; lead_id: string }
  | { index: number; status: 'duplicate'; reason: 'company_number' | 'company_name' | 'email'; lead_id?: string }
  | { index: number; status: 'rejected'; reason: string }

/**
 * The source label stored on the lead. ALWAYS namespaced with "import_": the database treats the
 * bare sources 'web_form' and 'booking_page' as "this person contacted us" (automated follow-ups
 * allowed), so an importer must never be able to claim them.
 */
export function importSourceLabel(source: string): string | null {
  const clean = source.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)
  return clean.length >= 2 ? `import_${clean}` : null
}

const EMAIL = /^[^\s@<>()[\],;:]+@[^\s@<>()[\],;:]+\.[^\s@<>()[\],;:]{2,}$/

export function cleanWebsite(raw: string | null | undefined): string | null {
  if (!raw) return null
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return `${u.protocol}//${u.hostname.toLowerCase()}`
  } catch {
    return null
  }
}

export async function importLeads(
  service: SupabaseClient,
  orgId: string,
  source: string,
  leads: ImportLeadInput[]
): Promise<ImportOutcome[]> {
  const label = importSourceLabel(source)
  if (!label) return leads.map((_, index) => ({ index, status: 'rejected' as const, reason: 'invalid source name' }))

  const { data: existing } = await service.from('companies').select('name').eq('organization_id', orgId).is('deleted_at', null).limit(5000)
  const names = new Set((existing ?? []).map((r: { name: string }) => normaliseCompanyName(r.name)))
  const out: ImportOutcome[] = []

  for (let index = 0; index < leads.length; index++) {
    const l = leads[index]
    const name = displayCompanyName((l.company_name ?? '').replace(/\s+/g, ' ').trim())
    if (!name || name.length > 200) { out.push({ index, status: 'rejected', reason: 'missing or too long company_name' }); continue }
    const email = l.contact?.email ? l.contact.email.trim().toLowerCase() : null
    if (email && !EMAIL.test(email)) { out.push({ index, status: 'rejected', reason: 'invalid email' }); continue }

    // 1. A company number we have seen before (the claim is atomic, so concurrent imports can't both win).
    if (l.company_number) {
      const { error } = await service.from('sourced_companies').insert({
        organization_id: orgId, company_number: l.company_number.trim().slice(0, 20), name, campaign: label, status: 'found',
      })
      if (error) {
        out.push(error.code === '23505' ? { index, status: 'duplicate', reason: 'company_number' } : { index, status: 'rejected', reason: 'could not record company' })
        continue
      }
    }
    // 2. Same person already has an open lead.
    const openLead = email ? await findOpenLeadIdByEmail(service, orgId, email) : null
    if (openLead) { out.push({ index, status: 'duplicate', reason: 'email', lead_id: openLead }); continue }
    // 3. Same company name already exists.
    if (names.has(normaliseCompanyName(name))) { out.push({ index, status: 'duplicate', reason: 'company_name' }); continue }

    const leadId = await createLeadFromSource(service, orgId, {
      source: label,
      isLimitedCompany: l.is_limited_company === true,
      companyName: name,
      website: cleanWebsite(l.website),
      location: l.address?.slice(0, 300) ?? null,
      industry: l.industry?.slice(0, 200) ?? null,
      contact: l.contact ? { fullName: l.contact.full_name?.slice(0, 200) ?? null, jobTitle: l.contact.job_title?.slice(0, 200) ?? null, email } : null,
      activity: { import: true, company_number: l.company_number ?? null },
    })
    if (!leadId) { out.push({ index, status: 'rejected', reason: 'could not create lead' }); continue }
    names.add(normaliseCompanyName(name))
    if (l.company_number) {
      await service.from('sourced_companies').update({ status: 'lead_created', lead_id: leadId }).eq('organization_id', orgId).eq('company_number', l.company_number.trim().slice(0, 20))
    }
    out.push({ index, status: 'created', lead_id: leadId })
  }
  return out
}
