'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { AGENTS, AGENT_KEYS, clampLevel, isAgentKey, type AgentKey } from '@/lib/agents'

// "Agents" settings. Owner/admin may change; tables are service-role only (migration 20261002000003).

export type AgentsCard = { canManage: boolean; paused: boolean; levels: Record<AgentKey, number> }

async function context() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/sign-in')
  const service = createServiceClient()
  const { data: profile } = await service.from('profiles').select('id, default_organization_id').eq('user_id', user.id).single()
  const orgId = profile?.default_organization_id ?? null
  const { data: membership } = orgId
    ? await service.from('memberships').select('role').eq('profile_id', profile!.id).eq('organization_id', orgId).eq('status', 'active').maybeSingle()
    : { data: null }
  return { service, userId: user.id, profileId: (profile?.id ?? null) as string | null, orgId, canManage: ['owner', 'admin'].includes(membership?.role ?? '') }
}

export async function getAgentsCard(): Promise<AgentsCard> {
  const { service, orgId, canManage } = await context()
  const levels = Object.fromEntries(AGENT_KEYS.map((k) => [k, 0])) as Record<AgentKey, number>
  if (!orgId) return { canManage, paused: false, levels }
  const [{ data: ctl }, { data: rows }] = await Promise.all([
    service.from('agent_controls').select('agents_paused').eq('organization_id', orgId).maybeSingle(),
    service.from('agent_settings').select('agent, autonomy_level').eq('organization_id', orgId),
  ])
  for (const r of rows ?? []) if (isAgentKey(r.agent)) levels[r.agent] = clampLevel(r.agent, r.autonomy_level)
  return { canManage, paused: ctl?.agents_paused ?? false, levels }
}

async function guard() {
  const c = await context()
  if (!c.orgId) return { error: 'No organization' as const }
  if (!c.canManage) return { error: 'Only owners and admins can change agents.' as const }
  const rl = await RATE_LIMITS.write(c.userId)
  if (!rl.success) return { error: `Too many requests. Try again in ${rl.resetIn}s.` as const }
  return { c, orgId: c.orgId }
}

export async function setAgentLevel(agent: string, level: number): Promise<{ error?: string }> {
  const g = await guard()
  if ('error' in g) return { error: g.error }
  if (!isAgentKey(agent)) return { error: 'Unknown agent' }
  if (!AGENTS[agent].live) return { error: 'This agent is not active yet.' }
  const { error } = await g.c.service.from('agent_settings').upsert(
    { organization_id: g.orgId, agent, autonomy_level: clampLevel(agent, level), updated_by: g.c.profileId, updated_at: new Date().toISOString() },
    { onConflict: 'organization_id,agent' }
  )
  return error ? { error: 'Could not save. Please try again.' } : {}
}

export async function setAgentsPaused(paused: boolean): Promise<{ error?: string }> {
  const g = await guard()
  if ('error' in g) return { error: g.error }
  const { error } = await g.c.service.from('agent_controls').upsert(
    { organization_id: g.orgId, agents_paused: paused === true, paused_by: g.c.profileId, paused_at: paused ? new Date().toISOString() : null },
    { onConflict: 'organization_id' }
  )
  return error ? { error: 'Could not save. Please try again.' } : {}
}
