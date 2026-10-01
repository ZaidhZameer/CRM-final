import type { SupabaseClient } from '@supabase/supabase-js'
import { isFirstBusinessDayOfQuarter, nextBusinessDaySendTime } from '@/lib/follow-ups'

// Quarterly reactivation: old leads that went quiet get ONE friendly, approval-gated check-in.
// Eligibility and the insert live in SQL (app.reactivation_candidates / schedule_reactivations,
// migration 20261001000003) so the existing follow-up interlocks apply unchanged. This only
// decides WHEN to run and what time to schedule. Drafting, approval and sending reuse the
// follow-up machinery (kind = 'reactivation' makes the sender stop after one touch).

export const REACTIVATION_IDLE_DAYS = 90
export const REACTIVATION_PER_ORG = 25

export type ReactivationResult =
  | { ran: false; reason: 'not_quarter_start' }
  | { ran: true; scheduled: number; skipped: number; scheduled_for: string }
  | { ran: true; error: string }

/** Runs on the first business day of each quarter (UK), or when `force` is set (?reactivate=1). */
export async function runReactivation(service: SupabaseClient, now = new Date(), force = false): Promise<ReactivationResult> {
  if (!force && !isFirstBusinessDayOfQuarter(now)) return { ran: false, reason: 'not_quarter_start' }
  const scheduledFor = nextBusinessDaySendTime(now)
  const { data, error } = await service.rpc('schedule_reactivations', {
    p_scheduled_for: scheduledFor.toISOString(),
    p_idle_days: REACTIVATION_IDLE_DAYS,
    p_per_org: REACTIVATION_PER_ORG,
  })
  if (error) {
    console.error('[reactivation] schedule failed', error.message)
    return { ran: true, error: error.message }
  }
  const row = (Array.isArray(data) ? data[0] : data) as { scheduled?: number; skipped?: number } | null
  return { ran: true, scheduled: row?.scheduled ?? 0, skipped: row?.skipped ?? 0, scheduled_for: scheduledFor.toISOString() }
}
