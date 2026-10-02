import type { SupabaseClient } from '@supabase/supabase-js'

// Agent registry: which AI agents exist, the highest autonomy each may ever have, and the check
// every agent entry point (cron, MCP, n8n callbacks) must pass first.
// Levels: 0 off, 1 suggest (drafts to Approvals), 2 act on internal things (notes, tasks, tags).
// Client-facing actions always need a human, so nothing is allowed above 2 yet.

export type AutonomyLevel = 0 | 1 | 2

// live: true only when the agent's code actually checks this setting. The rest are placeholders
// shown as "Not active yet" so the screen never promises control that does not exist.
export const AGENTS = {
  lead_finder: { label: 'Lead finder', maxLevel: 2, live: true },
  follow_up: { label: 'Follow-up writer', maxLevel: 1, live: false },
  proposal: { label: 'Proposal writer', maxLevel: 1, live: false },
  chief_of_staff: { label: 'Chief of staff (the Today page)', maxLevel: 1, live: false },
  marketing: { label: 'Marketing (content themes tool)', maxLevel: 1, live: false },
  seo: { label: 'SEO', maxLevel: 1, live: false },
} as const

export type AgentKey = keyof typeof AGENTS
export const AGENT_KEYS = Object.keys(AGENTS) as AgentKey[]

export function isAgentKey(v: unknown): v is AgentKey {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(AGENTS, v)
}

/** Clamp a requested level to what the agent may ever have. */
export function clampLevel(agent: AgentKey, level: unknown): AutonomyLevel {
  const n = typeof level === 'number' && Number.isInteger(level) ? level : 0
  return Math.max(0, Math.min(n, AGENTS[agent].maxLevel)) as AutonomyLevel
}

/** Pure decision, so it is easy to test: paused wins; missing settings mean off. */
export function levelAllows(paused: boolean, stored: number | null | undefined, agent: AgentKey, required: AutonomyLevel): boolean {
  if (paused || required === 0) return false
  return clampLevel(agent, stored ?? 0) >= required
}

export async function agentMayAct(service: SupabaseClient, orgId: string, agent: AgentKey, required: AutonomyLevel): Promise<boolean> {
  const [{ data: ctl }, { data: row }] = await Promise.all([
    service.from('agent_controls').select('agents_paused').eq('organization_id', orgId).maybeSingle(),
    service.from('agent_settings').select('autonomy_level').eq('organization_id', orgId).eq('agent', agent).maybeSingle(),
  ])
  return levelAllows(ctl?.agents_paused ?? false, row?.autonomy_level, agent, required)
}
