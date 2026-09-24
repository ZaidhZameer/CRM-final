// Follow-up cadence (spec: Obsidian SALES-OS/INTERNAL/FLOWLEAD_FOLLOWUPS_SPEC_2026-09-24.md).
// The rule cadence is a ceiling: the AI drafter may delay or skip a step, never bring one forward.

export const FOLLOW_UP_TIMEZONE = 'Europe/London'
export const SEND_HOUR = 9
export const SEND_MINUTE = 30

/** Business days to wait before each automated step (step 1 counts from enrichment). */
export const CADENCE_BUSINESS_DAYS = [3, 4, 7] as const
export const MAX_AUTOMATED_STEPS = CADENCE_BUSINESS_DAYS.length

/** Wall-clock parts of an instant in a time zone. */
function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(date)
  const get = (t: string) => parts.find((p) => p.type === t)!.value
  return {
    year: Number(get('year')), month: Number(get('month')), day: Number(get('day')),
    hour: Number(get('hour')), minute: Number(get('minute')), second: Number(get('second')),
    weekday: get('weekday'),
  }
}

/** The UTC instant for a wall-clock time in a zone (DST-safe, via the zone's offset at that time). */
function zonedTimeToUtc(y: number, m: number, d: number, hh: number, mm: number, timeZone: string): Date {
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm))
  const p = zonedParts(guess, timeZone)
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return new Date(guess.getTime() - (asIfUtc - guess.getTime()))
}

/**
 * When step `step` (1-based) should go out, counted in business days from `from`,
 * at 09:30 UK time. Returns null past the last automated step.
 */
export function scheduledSendTime(from: Date, step: number, timeZone = FOLLOW_UP_TIMEZONE): Date | null {
  const days = CADENCE_BUSINESS_DAYS[step - 1]
  if (days === undefined) return null

  const start = zonedParts(from, timeZone)
  // Walk calendar days in the zone, counting only Mon-Fri.
  const cursor = new Date(Date.UTC(start.year, start.month - 1, start.day))
  let remaining = days
  while (remaining > 0) {
    cursor.setUTCDate(cursor.getUTCDate() + 1)
    const dow = cursor.getUTCDay()
    if (dow !== 0 && dow !== 6) remaining--
  }
  return zonedTimeToUtc(
    cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, cursor.getUTCDate(),
    SEND_HOUR, SEND_MINUTE, timeZone
  )
}
