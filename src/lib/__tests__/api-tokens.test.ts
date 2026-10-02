import { describe, it, expect } from 'vitest'
import { generateToken, hashToken, parseBearer, verifyBearer } from '../api-tokens'
import { fakeSupabase } from './fake-supabase'

describe('generateToken', () => {
  it('has the flk_ prefix, 32 random bytes in base64url, and a matching sha256', () => {
    const { token, sha256 } = generateToken()
    expect(token).toMatch(/^flk_[A-Za-z0-9_-]{43}$/)
    expect(sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(sha256).toBe(hashToken(token))
  })
  it('never repeats', () => {
    expect(generateToken().token).not.toBe(generateToken().token)
  })
})

describe('parseBearer', () => {
  const { token } = generateToken()
  it('accepts a well-formed header', () => {
    expect(parseBearer(`Bearer ${token}`)).toBe(token)
    expect(parseBearer(`bearer  ${token}`)).toBe(token)
  })
  it('rejects anything else', () => {
    expect(parseBearer(null)).toBeNull()
    expect(parseBearer('')).toBeNull()
    expect(parseBearer(token)).toBeNull()
    expect(parseBearer('Bearer flk_short')).toBeNull()
    expect(parseBearer(`Basic ${token}`)).toBeNull()
    expect(parseBearer(`Bearer ${token}x`)).toBeNull()
  })
})

function setup(overrides: Record<string, unknown> = {}, membership: Record<string, unknown> | null = { profile_id: 'p1', organization_id: 'o1', status: 'active', role: 'sales' }) {
  const { token, sha256 } = generateToken()
  const db = {
    api_tokens: [{ id: 't1', organization_id: 'o1', profile_id: 'p1', name: 'Claude', token_sha256: sha256, scopes: ['read', 'propose'], last_used_at: null, expires_at: null, revoked_at: null, ...overrides }],
    memberships: membership ? [membership] : [],
  }
  const fake = fakeSupabase(db)
  return { token, fake, db }
}

describe('verifyBearer', () => {
  it('resolves a valid token to org, profile, current role and scopes, and stamps last_used_at', async () => {
    const { token, fake, db } = setup()
    const v = await verifyBearer(fake.client, `Bearer ${token}`)
    expect(v).toEqual({ orgId: 'o1', profileId: 'p1', role: 'sales', scopes: ['read', 'propose'], tokenId: 't1', tokenName: 'Claude' })
    expect(db.api_tokens[0].last_used_at).toBeTruthy()
  })
  it('rejects an unknown token, a malformed header and a missing header', async () => {
    const { fake } = setup()
    expect(await verifyBearer(fake.client, `Bearer ${generateToken().token}`)).toBeNull()
    expect(await verifyBearer(fake.client, 'Bearer nope')).toBeNull()
    expect(await verifyBearer(fake.client, null)).toBeNull()
  })
  it('rejects revoked and expired tokens', async () => {
    const a = setup({ revoked_at: new Date().toISOString() })
    expect(await verifyBearer(a.fake.client, `Bearer ${a.token}`)).toBeNull()
    const b = setup({ expires_at: new Date(Date.now() - 1000).toISOString() })
    expect(await verifyBearer(b.fake.client, `Bearer ${b.token}`)).toBeNull()
    const c = setup({ expires_at: new Date(Date.now() + 60_000).toISOString() })
    expect(await verifyBearer(c.fake.client, `Bearer ${c.token}`)).not.toBeNull()
  })
  it('rejects when the membership is not active or gone', async () => {
    const a = setup({}, { profile_id: 'p1', organization_id: 'o1', status: 'suspended', role: 'sales' })
    expect(await verifyBearer(a.fake.client, `Bearer ${a.token}`)).toBeNull()
    const b = setup({}, null)
    expect(await verifyBearer(b.fake.client, `Bearer ${b.token}`)).toBeNull()
    const c = setup({}, { profile_id: 'p1', organization_id: 'OTHER', status: 'active', role: 'owner' })
    expect(await verifyBearer(c.fake.client, `Bearer ${c.token}`)).toBeNull()
  })
  it('uses the current role, not the role at creation', async () => {
    const { token, fake } = setup({}, { profile_id: 'p1', organization_id: 'o1', status: 'active', role: 'viewer' })
    expect((await verifyBearer(fake.client, `Bearer ${token}`))?.role).toBe('viewer')
  })
  it('does not rewrite last_used_at more than once a minute', async () => {
    const recent = new Date(Date.now() - 5000).toISOString()
    const { token, fake, db } = setup({ last_used_at: recent })
    await verifyBearer(fake.client, `Bearer ${token}`)
    expect(db.api_tokens[0].last_used_at).toBe(recent)
  })
})
