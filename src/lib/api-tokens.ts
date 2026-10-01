import { createHash, randomBytes } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

// Personal access tokens for the MCP endpoint. Only a sha256 is stored; the token is shown once.
// Spec: Obsidian SALES-OS/INTERNAL/FLOWLEAD_MCP_SPEC_2026-10-01.md

export const TOKEN_PREFIX = 'flk_'
export const TOKEN_SCOPES = ['read', 'propose'] as const
export type TokenScope = (typeof TOKEN_SCOPES)[number]

// 32 random bytes encode to exactly 43 base64url characters.
const BEARER_RE = /^Bearer[ \t]+(flk_[A-Za-z0-9_-]{43})$/i
const LAST_USED_REFRESH_MS = 60_000

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** A new token: `flk_` + 32 random bytes (base64url), and the sha256 that gets stored. */
export function generateToken(): { token: string; sha256: string } {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
  return { token, sha256: hashToken(token) }
}

/** Extracts the token from an `Authorization: Bearer flk_...` header, or null if malformed. */
export function parseBearer(header: string | null | undefined): string | null {
  if (!header) return null
  const m = BEARER_RE.exec(header.trim())
  return m ? m[1] : null
}

export type VerifiedToken = {
  orgId: string
  profileId: string
  role: string
  scopes: TokenScope[]
  tokenId: string
  tokenName: string
}

/**
 * Resolves a bearer header to the caller, or null. The token is matched by an indexed lookup on
 * its sha256 (never compared in application code, so there is no timing signal on the secret).
 * Revoked and expired tokens are rejected, and the role is read from the CURRENT active
 * membership, so removing someone from the team, or changing their role, takes effect at once.
 */
export async function verifyBearer(service: SupabaseClient, header: string | null | undefined): Promise<VerifiedToken | null> {
  const token = parseBearer(header)
  if (!token) return null

  const { data: row } = await service
    .from('api_tokens')
    .select('id, organization_id, profile_id, name, scopes, last_used_at, expires_at, revoked_at')
    .eq('token_sha256', hashToken(token))
    .maybeSingle()
  if (!row || row.revoked_at) return null
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return null

  const { data: membership } = await service
    .from('memberships')
    .select('role')
    .eq('profile_id', row.profile_id)
    .eq('organization_id', row.organization_id)
    .eq('status', 'active')
    .maybeSingle()
  if (!membership?.role) return null

  // Best effort, and at most once a minute so a busy agent doesn't write on every call.
  const lastUsed = row.last_used_at ? new Date(row.last_used_at).getTime() : 0
  if (Date.now() - lastUsed > LAST_USED_REFRESH_MS) {
    try {
      await service.from('api_tokens').update({ last_used_at: new Date().toISOString() }).eq('id', row.id)
    } catch {
      /* not worth failing the request */
    }
  }

  return {
    orgId: row.organization_id,
    profileId: row.profile_id,
    role: membership.role,
    scopes: (row.scopes ?? []).filter((s: string): s is TokenScope => (TOKEN_SCOPES as readonly string[]).includes(s)),
    tokenId: row.id,
    tokenName: row.name,
  }
}
