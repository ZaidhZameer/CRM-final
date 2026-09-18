import { timingSafeEqual } from 'node:crypto'
import type { NextRequest } from 'next/server'

// Shared-secret verification for the n8n automation integration.
//
// Deliberately different from the existing cron routes (`?key=` query param):
//   1. Secret travels in a HEADER, not the URL — query strings leak into access logs,
//      proxy logs, browser history and Referer headers.
//   2. FAIL CLOSED — if AUTOMATION_SHARED_SECRET is unset or empty, every request is
//      rejected. An unset secret must never mean "allow everyone".
//   3. Comparison is timing-safe.

export const AUTOMATION_SECRET_HEADER = 'x-flowlead-secret'

export type SecretCheck =
  | { ok: true }
  | { ok: false; reason: 'not_configured' | 'missing_header' | 'mismatch' }

/** Constant-time string compare that does not leak length via early return. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  // timingSafeEqual throws on length mismatch, so normalise to a fixed width first.
  const len = Math.max(bufA.length, bufB.length)
  const padA = Buffer.alloc(len)
  const padB = Buffer.alloc(len)
  bufA.copy(padA)
  bufB.copy(padB)
  return timingSafeEqual(padA, padB) && bufA.length === bufB.length
}

export function verifyAutomationSecret(request: NextRequest): SecretCheck {
  const expected = process.env.AUTOMATION_SHARED_SECRET
  if (!expected || expected.length < 16) {
    // Unset, empty, or trivially short — treat the endpoint as disabled.
    return { ok: false, reason: 'not_configured' }
  }

  const provided = request.headers.get(AUTOMATION_SECRET_HEADER)
  if (!provided) return { ok: false, reason: 'missing_header' }

  return safeEqual(provided, expected) ? { ok: true } : { ok: false, reason: 'mismatch' }
}
