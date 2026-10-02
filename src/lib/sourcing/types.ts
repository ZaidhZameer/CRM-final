/** Shared result/error types for the lead-sourcing library (never throws; returns these). */
export type SourcingError =
  | { kind: 'missing_key'; message: string }
  | { kind: 'rate_limited'; message: string; retryAfterMs?: number }
  | { kind: 'http_error'; message: string; status: number }
  | { kind: 'bad_response'; message: string }

export type SourcingResult<T> = { ok: true; data: T } | { ok: false; error: SourcingError }

export const ok = <T>(data: T): SourcingResult<T> => ({ ok: true, data })
export const fail = <T = never>(error: SourcingError): SourcingResult<T> => ({ ok: false, error })

export type SleepFn = (ms: number) => Promise<void>
export const defaultSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms))
