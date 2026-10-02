import { defaultSleep, type SleepFn } from './types'

export type RateLimiter = {
  /** Resolves when a request slot is free, then reserves it. Slots are granted in call order. */
  acquire(): Promise<void>
}

/**
 * Sliding-window limiter: at most `max` acquisitions in any `windowMs`.
 * Calls are serialised through a promise chain so concurrent callers queue fairly.
 * Companies House allows 600 requests per 5 minutes per key.
 */
export function createRateLimiter(opts: {
  max: number
  windowMs: number
  now?: () => number
  sleep?: SleepFn
}): RateLimiter {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? defaultSleep
  const stamps: number[] = []
  let chain: Promise<void> = Promise.resolve()

  async function take(): Promise<void> {
    for (;;) {
      const t = now()
      while (stamps.length > 0 && t - stamps[0] >= opts.windowMs) stamps.shift()
      if (stamps.length < opts.max) {
        stamps.push(t)
        return
      }
      await sleep(Math.max(1, stamps[0] + opts.windowMs - t))
    }
  }

  return {
    acquire() {
      const next = chain.then(take)
      chain = next.catch(() => undefined)
      return next
    },
  }
}
