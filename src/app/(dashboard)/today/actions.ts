'use server'

import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { buildTodayBrief, EMPTY_BRIEF, type TodayBrief } from '@/lib/today-brief'

export type { TodayItem, TodaySection, TodayBrief } from '@/lib/today-brief'

// The owner's morning brief, read through the user's RLS client and scoped to their org; the
// service client is used only for the profile lookup, like the other actions.
export async function getTodayBrief(): Promise<TodayBrief> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return EMPTY_BRIEF

  const { data: profile } = await createServiceClient()
    .from('profiles')
    .select('default_organization_id')
    .eq('user_id', user.id)
    .single()
  const orgId = profile?.default_organization_id
  if (!orgId) return EMPTY_BRIEF

  return buildTodayBrief(supabase, orgId)
}
