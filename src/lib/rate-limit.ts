import { Ratelimit } from '@upstash/ratelimit'
import { redis } from '@/lib/redis'

export interface RateLimitResult {
  success: boolean
  limit: number
  remaining: number
  resetIn: number
}

function createLimiter(prefix: string, tokens: number, windowSec: number) {
  return new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(tokens, `${windowSec} s`),
    prefix: `rl:${prefix}`,
    analytics: false,
  })
}

const limiters = {
  auth: createLimiter('auth', 60, 60),
  aiResearch: createLimiter('ai', 10, 60),
  import: createLimiter('import', 3, 60),
  api: createLimiter('api', 120, 60),
  write: createLimiter('write', 60, 60),
  form: createLimiter('form', 30, 60),
  mcp: createLimiter('mcp', 60, 60),
}

async function check(
  limiter: Ratelimit,
  key: string
): Promise<RateLimitResult> {
  const { success, limit, remaining, reset } = await limiter.limit(key)
  const resetIn = Math.max(0, Math.ceil((reset - Date.now()) / 1000))
  return { success, limit, remaining, resetIn }
}

export const RATE_LIMITS = {
  auth: (key: string) => check(limiters.auth, key),
  aiResearch: (key: string) => check(limiters.aiResearch, key),
  import: (key: string) => check(limiters.import, key),
  api: (key: string) => check(limiters.api, key),
  write: (key: string) => check(limiters.write, key),
  form: (key: string) => check(limiters.form, key),
  /** MCP tool traffic, keyed by api token id. */
  mcp: (key: string) => check(limiters.mcp, key),
}
