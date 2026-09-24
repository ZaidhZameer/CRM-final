import { timingSafeEqual } from 'node:crypto'
import type { NextRequest } from 'next/server'

// Shared-secret verification for the n8n automation integration and cron routes.
//
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

function verifyHeaderSecret(
  request: NextRequest,
  header: string,
  expected: string | undefined
): SecretCheck {
  if (!expected || expected.length < 16) {
    // Unset, empty, or trivially short — treat the endpoint as disabled.
    return { ok: false, reason: 'not_configured' }
  }

  const provided = request.headers.get(header)
  if (!provided) return { ok: false, reason: 'missing_header' }

  return safeEqual(provided, expected) ? { ok: true } : { ok: false, reason: 'mismatch' }
}

export function verifyAutomationSecret(request: NextRequest): SecretCheck {
  return verifyHeaderSecret(request, AUTOMATION_SECRET_HEADER, process.env.AUTOMATION_SHARED_SECRET)
}

export const CRON_SECRET_HEADER = 'x-cron-secret'

/** Same rules as the automation secret, for /api/cron/* (called by the n8n scheduler). */
export function verifyCronSecret(request: NextRequest): SecretCheck {
  return verifyHeaderSecret(request, CRON_SECRET_HEADER, process.env.CRON_SECRET)
}
