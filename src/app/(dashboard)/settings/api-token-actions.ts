'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { generateToken, TOKEN_SCOPES, type TokenScope } from '@/lib/api-tokens'

// "Connected agents": personal access tokens for the MCP endpoint (/api/mcp).
// The table is service-role only; every action here checks owner/admin or self first.
// Spec: Obsidian SALES-OS/INTERNAL/FLOWLEAD_MCP_SPEC_2026-10-01.md

export type ApiTokenRow = {
  id: string
  name: string
  scopes: string[]
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
  ownerName: string | null
  mine: boolean
}

export type AgentsOverview = { canManage: boolean; tokens: ApiTokenRow[]; endpoint: string }

const MAX_ACTIVE_TOKENS = 20

async function context() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/sign-in')
  const service = createServiceClient()
  const { data: profile } = await service
    .from('profiles')
    .select('id, default_organization_id')
    .eq('user_id', user.id)
    .single()
  const orgId = profile?.default_organization_id ?? null
  const { data: membership } = orgId
    ? await service
        .from('memberships')
        .select('role')
        .eq('profile_id', profile!.id)
        .eq('organization_id', orgId)
        .eq('status', 'active')
        .maybeSingle()
    : { data: null }
  return {
    service,
    orgId,
    profileId: (profile?.id ?? null) as string | null,
    role: (membership?.role ?? null) as string | null,
    canManage: ['owner', 'admin'].includes(membership?.role ?? ''),
  }
}

function appOrigin(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? '').split(',')[0].trim().replace(/\/$/, '')
}

/** Token metadata only: the secret and its hash never leave the server. */
export async function listApiTokens(): Promise<AgentsOverview> {
  const { service, orgId, profileId, role, canManage } = await context()
  const endpoint = `${appOrigin()}/api/mcp`
  if (!orgId || !profileId || !role) return { canManage: false, tokens: [], endpoint }

  let q = service
    .from('api_tokens')
    .select('id, name, scopes, created_at, last_used_at, expires_at, revoked_at, profile_id, profiles(full_name)')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false })
    .limit(100)
  if (!canManage) q = q.eq('profile_id', profileId)
  const { data } = await q

  return {
    canManage,
    endpoint,
    tokens: (data ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      scopes: t.scopes ?? [],
      createdAt: t.created_at,
      lastUsedAt: t.last_used_at,
      expiresAt: t.expires_at,
      revokedAt: t.revoked_at,
      ownerName: ((t.profiles ?? null) as unknown as { full_name: string | null } | null)?.full_name ?? null,
      mine: t.profile_id === profileId,
    })),
  }
}

/** Creates a token for the signed-in owner/admin. The plaintext is returned once and never stored. */
export async function createApiToken(input: { name: string; scopes: string[]; expiresInDays?: number | null }): Promise<{ error?: string; token?: string }> {
  const { service, orgId, profileId, canManage } = await context()
  if (!orgId || !profileId) return { error: 'No organization' }
  if (!canManage) return { error: 'Only owners and admins can connect agents.' }

  const name = input.name.replace(/[\r\n\t]+/g, ' ').trim()
  if (!name || name.length > 80) return { error: 'Give the connection a name of 1-80 characters.' }
  const scopes = [...new Set(input.scopes)].filter((s): s is TokenScope => (TOKEN_SCOPES as readonly string[]).includes(s))
  if (!scopes.includes('read')) scopes.unshift('read') // proposing without reading is not useful
  let expiresAt: string | null = null
  if (input.expiresInDays != null) {
    const days = Math.floor(input.expiresInDays)
    if (!Number.isFinite(days) || days < 1 || days > 365) return { error: 'Expiry must be between 1 and 365 days.' }
    expiresAt = new Date(Date.now() + days * 86_400_000).toISOString()
  }

  const { count } = await service
    .from('api_tokens')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', orgId)
    .is('revoked_at', null)
  if ((count ?? 0) >= MAX_ACTIVE_TOKENS) return { error: `You can have up to ${MAX_ACTIVE_TOKENS} active connections. Revoke one first.` }

  const { token, sha256 } = generateToken()
  const { data: row, error } = await service
    .from('api_tokens')
    .insert({ organization_id: orgId, profile_id: profileId, name, token_sha256: sha256, scopes, expires_at: expiresAt })
    .select('id')
    .single()
  if (error || !row) return { error: 'Could not create the connection. Please try again.' }

  await service.from('activity_logs').insert({
    organization_id: orgId,
    actor_profile_id: profileId,
    entity_type: 'api_token',
    entity_id: row.id,
    action: 'created',
    after_json: { name, scopes },
  })
  return { token }
}

/** Revokes immediately: the next request with that token gets a 401. Owner/admin only. */
export async function revokeApiToken(tokenId: string): Promise<{ error?: string }> {
  const { service, orgId, profileId, canManage } = await context()
  if (!orgId || !profileId) return { error: 'No organization' }
  if (!canManage) return { error: 'Only owners and admins can revoke connections.' }
  const { data } = await service
    .from('api_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', tokenId)
    .eq('organization_id', orgId)
    .is('revoked_at', null)
    .select('id, name')
    .maybeSingle()
  if (!data) return { error: 'Connection not found.' }
  await service.from('activity_logs').insert({
    organization_id: orgId,
    actor_profile_id: profileId,
    entity_type: 'api_token',
    entity_id: data.id,
    action: 'updated',
    after_json: { name: data.name, revoked: true },
  })
  return {}
}
