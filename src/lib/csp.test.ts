import { describe, expect, it } from 'vitest'
import { buildCsp } from './csp'

describe('buildCsp', () => {
  const csp = buildCsp({
    supabaseUrl: 'https://abc.supabase.co/',
    sentryDsn: 'https://key@o123.ingest.sentry.io/456',
  })

  it('locks down framing, objects, base and forms', () => {
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'self'")
    expect(csp).toContain("form-action 'self'")
    expect(csp).toContain("default-src 'self'")
  })

  it('allows Supabase (http + ws) and Sentry in connect-src', () => {
    expect(csp).toContain(
      "connect-src 'self' https://abc.supabase.co wss://abc.supabase.co https://o123.ingest.sentry.io"
    )
  })

  it('only allows unsafe-eval in dev', () => {
    expect(csp).not.toContain('unsafe-eval')
    expect(buildCsp({ isDev: true })).toContain("'unsafe-eval'")
  })

  it('tolerates missing or invalid env', () => {
    expect(buildCsp({ supabaseUrl: 'not a url' })).toContain("connect-src 'self';")
  })
})
