// Pure helpers for the "Today" brief: UK-day boundaries and the headline.

const TZ = 'Europe/London'

/** Offset (ms) of Europe/London from UTC at the given instant (0 in winter, 1h in BST). */
function londonOffsetMs(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return asUtc - Math.floor(at.getTime() / 1000) * 1000
}

/** The UTC instant at which the UK calendar day y-m-d begins. */
function ukMidnightUtc(y: number, m: number, d: number): Date {
  const guess = Date.UTC(y, m - 1, d)
  // The offset can differ either side of a clock change; settle on the one in force at that midnight.
  let result = guess - londonOffsetMs(new Date(guess))
  result = guess - londonOffsetMs(new Date(result))
  return new Date(result)
}

/** Start (inclusive) and end (exclusive) of the current UK calendar day, as ISO strings. */
export function ukDayBounds(now: Date = new Date()): { start: string; end: string } {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value)
  const y = get('year'), m = get('month'), d = get('day')
  // Date.UTC rolls over month ends, so d + 1 is safe.
  return { start: ukMidnightUtc(y, m, d).toISOString(), end: ukMidnightUtc(y, m, d + 1).toISOString() }
}

export type TodayCounts = { approvals: number; replies: number; proposals: number; problems: number }

/** Things that need the owner: approvals, replies, proposals to chase and problems. */
export function needsYouCount(c: TodayCounts): number {
  return c.approvals + c.replies + c.proposals + c.problems
}

export function todayHeadline(c: TodayCounts): string {
  const n = needsYouCount(c)
  if (n === 0) return "You're all caught up"
  return n === 1 ? '1 thing needs you today' : `${n} things need you today`
}
