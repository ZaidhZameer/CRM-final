import type { SupabaseClient } from '@supabase/supabase-js'

export const DEFAULT_DAILY_CAP_CENTS = 100

/** Today's AI spend against the org's daily cap (organizations.ai_daily_cap_cents). */
export async function getAiBudget(service: SupabaseClient, orgId: string) {
  const [{ data: org }, { data: rows }] = await Promise.all([
    service.from('organizations').select('ai_daily_cap_cents').eq('id', orgId).single(),
    service
      .from('ai_usage_log')
      .select('cost_usd_cents')
      .eq('organization_id', orgId)
      .gte('created_at', new Date(new Date().setHours(0, 0, 0, 0)).toISOString()),
  ])
  const spentCents = (rows ?? []).reduce((sum: number, r: { cost_usd_cents: number | string }) => sum + Number(r.cost_usd_cents), 0)
  const capCents = org?.ai_daily_cap_cents ?? DEFAULT_DAILY_CAP_CENTS
  return { spentCents, capCents, exhausted: spentCents >= capCents }
}

export function budgetMessage(b: { spentCents: number; capCents: number }): string {
  return `Daily AI budget reached (${(b.spentCents / 100).toFixed(2)} / ${(b.capCents / 100).toFixed(2)} USD)`
}
