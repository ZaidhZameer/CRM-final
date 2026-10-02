import { describe, it, expect, vi } from 'vitest'

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}))
vi.mock('@/lib/rate-limit', () => ({
  RATE_LIMITS: { auth: async () => ({ success: true, resetIn: 0 }), api: async () => ({ success: true, resetIn: 0 }), form: async () => ({ success: true, resetIn: 0 }) },
}))

import { NextRequest } from 'next/server'
import proxy from '../../proxy'

const call = (path: string) => proxy(new NextRequest(`http://localhost${path}`, { method: 'POST' }))

describe('proxy with no session cookie', () => {
  it('lets /api/mcp through (it authenticates by bearer token itself)', async () => {
    const res = await call('/api/mcp')
    expect(res.status).toBe(200)
    expect(res.headers.get('location')).toBeNull()
  })
  it('still redirects every other private page and API route to sign-in', async () => {
    for (const path of ['/leads', '/settings', '/approvals', '/api/search', '/api/mcpx-not-this/../settings']) {
      const res = await call(path)
      expect(res.status, path).toBe(307)
      expect(res.headers.get('location'), path).toContain('/sign-in')
    }
  })
})
