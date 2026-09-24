'use server'

import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

export type AttentionCounts = { pendingApprovals: number; failedJobs24h: number }

const EMPTY: AttentionCounts = { pendingApprovals: 0, failedJobs24h: 0 }

/**
 * What needs the owner's attention, for the top-bar bell: approvals waiting on a decision and
 * automation jobs that failed in the last 24 hours. Reads through the user's RLS client.
 */
export async function getAttentionCounts(): Promise<AttentionCounts> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return EMPTY

  // Service client for the profile lookup, like every other action (see the profiles RLS fix).
  const { data: profile } = await createServiceClient()
    .from('profiles')
    .select('default_organization_id')
    .eq('user_id', user.id)
    .single()
  const orgId = profile?.default_organization_id
  if (!orgId) return EMPTY

  const now = new Date().toISOString()
  const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString()

  const [approvals, jobs] = await Promise.all([
    supabase
      .from('approvals')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('status', 'pending')
      .or(`expires_at.is.null,expires_at.gt.${now}`),
    supabase
      .from('jobs')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('status', 'failed')
      .gte('finished_at', since),
  ])

  return { pendingApprovals: approvals.count ?? 0, failedJobs24h: jobs.count ?? 0 }
}
