import type { SupabaseClient } from '@supabase/supabase-js'
import { discoverContact } from './contact-discovery'
import { levelAllows } from '@/lib/agents'

// Daily contact discovery: for sourced/imported leads that have a website but no contact email,
// verify the site and fill in a PUBLISHED role address on the company's own domain. Writes only the
// contact email and a lead note; sends nothing. Needs the lead_finder agent at level 1+ and agents
// not paused. Capped per organisation per run.

const PER_ORG_LIMIT = 10

export type DiscoverSummary = { checked: number; filled: number }

export async function runContactDiscovery(
  service: SupabaseClient,
  deps: { discover?: typeof discoverContact } = {}
): Promise<Record<string, DiscoverSummary>> {
  const discover = deps.discover ?? discoverContact
  const [{ data: paused }, { data: levels }] = await Promise.all([
    service.from('agent_controls').select('organization_id').eq('agents_paused', true),
    service.from('agent_settings').select('organization_id, autonomy_level').eq('agent', 'lead_finder'),
  ])
  const pausedOrgs = new Set(((paused ?? []) as { organization_id: string }[]).map((r) => r.organization_id))
  const out: Record<string, DiscoverSummary> = {}

  for (const row of (levels ?? []) as { organization_id: string; autonomy_level: number }[]) {
    if (!levelAllows(pausedOrgs.has(row.organization_id), row.autonomy_level, 'lead_finder', 1)) continue

    const { data: leads } = await service
      .from('leads')
      .select('id, contact_id, company_id, source, companies(name, website), contacts(email)')
      .eq('organization_id', row.organization_id)
      .is('deleted_at', null)
      .or('source.like.companies_house%,source.like.import_%')
      .not('company_id', 'is', null)
      .not('contact_id', 'is', null)
      .order('created_at', { ascending: true })
      .limit(100)

    const summary: DiscoverSummary = { checked: 0, filled: 0 }
    for (const l of (leads ?? []) as unknown as {
      id: string; contact_id: string
      companies: { name: string; website: string | null } | null
      contacts: { email: string | null } | null
    }[]) {
      if (summary.checked >= PER_ORG_LIMIT) break
      if (l.contacts?.email || !l.companies?.website) continue
      summary.checked++
      const res = await discover(l.companies.website, { name: l.companies.name }).catch(() => null)
      if (!res || !res.ok || !res.email) continue
      const { error } = await service.from('contacts').update({ email: res.email.email }).eq('id', l.contact_id).eq('organization_id', row.organization_id).is('email', null)
      if (error) continue
      summary.filled++
      await service.from('notes').insert({
        organization_id: row.organization_id, entity_type: 'lead', entity_id: l.id, content: `Contact address found on the company's own website (${res.sourceUrl}): ${res.email.email}`,
      })
    }
    out[row.organization_id] = summary
  }
  return out
}
