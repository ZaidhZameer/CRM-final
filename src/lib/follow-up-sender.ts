import type { SupabaseClient } from '@supabase/supabase-js'
import { FOLLOW_UP_TIMEZONE, MAX_AUTOMATED_STEPS, scheduledSendTime } from '@/lib/follow-ups'
import { getMailAccessToken, sendGmail, type MailConnection } from '@/lib/gmail'

// Sends approved follow-ups from the org's connected mailbox at their scheduled time.
// Approval only queues the message; this runs from the lifecycle cron.
// Spec decision 3: plain text, business hours, at most DAILY_SEND_CAP automated sends per day.

export const DAILY_SEND_CAP = 30
const SEND_START_HOUR = 8
const SEND_END_HOUR = 18

/** Mon-Fri, 08:00-17:59 in the UK. Exported for tests. */
export function isSendWindow(now: Date, timeZone = FOLLOW_UP_TIMEZONE): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  const weekday = parts.find((p) => p.type === 'weekday')!.value
  const hour = Number(parts.find((p) => p.type === 'hour')!.value)
  return !['Sat', 'Sun'].includes(weekday) && hour >= SEND_START_HOUR && hour < SEND_END_HOUR
}

/** Subject for step 2+ so the recipient's client threads it with the first email. */
export function threadedSubject(first: string | null, current: string): string {
  if (!first) return current
  return /^re:/i.test(first) ? first : `Re: ${first}`
}

type Queued = {
  id: string
  organization_id: string
  lead_id: string
  to_email: string | null
  subject: string | null
  body: string
  approval_id: string | null
  follow_up_id: string | null
}

/** Marks a message failed; logs if even that is refused, so a stuck row is never silent. */
async function markMessageFailed(service: SupabaseClient, id: string, message: string) {
  const { error } = await service.from('outreach_messages').update({ status: 'failed', error_message: message.slice(0, 1000) }).eq('id', id)
  if (error) console.error('[follow-ups] could not mark message failed', id, error.message)
}

async function recordFailure(service: SupabaseClient, m: Queued, message: string) {
  await markMessageFailed(service, m.id, message)
  // A failed job makes the problem visible in Jobs and on the bell.
  await service.from('jobs').insert({
    organization_id: m.organization_id,
    job_type: 'followup.send',
    subject_type: 'outreach_message',
    subject_id: m.id,
    status: 'failed',
    finished_at: new Date().toISOString(),
    error_message: message.slice(0, 1000),
  })
}

/** Called right after a human approves a follow-up in the inbox: queue it for its send time. */
export async function queueApprovedFollowUp(service: SupabaseClient, approvalId: string): Promise<void> {
  const { data: a } = await service
    .from('approvals')
    .select('id, organization_id, status, action_type, payload_json, edited_payload_json, job_id')
    .eq('id', approvalId)
    .single()
  if (!a || a.status !== 'approved' || a.action_type !== 'send_follow_up_email') return
  const payload = (a.edited_payload_json ?? a.payload_json) as { subject?: string; body?: string; outreach_message_id?: string }
  if (!payload.outreach_message_id) return
  await service
    .from('outreach_messages')
    .update({ status: 'queued', subject: payload.subject, body: payload.body })
    .eq('id', payload.outreach_message_id)
    .eq('organization_id', a.organization_id)
  // The drafting job is finished once a human decided; sending is tracked on the message itself.
  if (a.job_id) {
    await service.from('jobs').update({ status: 'done', finished_at: new Date().toISOString(), result_json: { approved: true } }).eq('id', a.job_id)
  }
}

/** Called when a human rejects a follow-up: that step is closed, the sequence stops. */
export async function closeRejectedFollowUp(service: SupabaseClient, approvalId: string): Promise<void> {
  const { data: a } = await service
    .from('approvals')
    .select('organization_id, status, action_type, payload_json')
    .eq('id', approvalId)
    .single()
  if (!a || a.status !== 'rejected' || a.action_type !== 'send_follow_up_email') return
  const payload = a.payload_json as { follow_up_id?: string }
  if (payload.follow_up_id) {
    await service
      .from('follow_ups')
      .update({ status: 'skipped', decided_by: 'human', reason: 'Rejected in the Approval Inbox' })
      .eq('id', payload.follow_up_id)
      .eq('organization_id', a.organization_id)
  }
}

/** Sends every queued, approved follow-up whose time has come. Returns counts for the cron. */
export async function sendDueFollowUps(service: SupabaseClient, now = new Date()) {
  const result = { sent: 0, waiting_for_mailbox: 0, failed: 0, blocked: 0, outside_window: false }
  if (!isSendWindow(now)) {
    result.outside_window = true
    return result
  }

  const { data: queued } = await service
    .from('outreach_messages')
    .select('id, organization_id, lead_id, to_email, subject, body, approval_id, follow_up_id')
    .eq('status', 'queued')
    .eq('channel', 'email')
    .order('created_at', { ascending: true })
    .limit(100)

  const connections = new Map<string, MailConnection | null>()
  const sentToday = new Map<string, number>()
  const startOfDay = new Date(new Date(now).setHours(0, 0, 0, 0)).toISOString()

  for (const m of (queued ?? []) as Queued[]) {
    const { data: fu } = m.follow_up_id
      ? await service.from('follow_ups').select('id, status, step, scheduled_for').eq('id', m.follow_up_id).single()
      : { data: null }
    if (fu && new Date(fu.scheduled_for) > now) continue // approved early: wait for its slot
    if (fu && fu.status !== 'pending') {
      // The lead replied, opted out or the step was closed while it waited.
      await markMessageFailed(service, m.id, `not sent: follow-up is ${fu.status}`)
      result.blocked++
      continue
    }

    if (!connections.has(m.organization_id)) {
      const { data: c } = await service
        .from('mail_connections')
        .select('id, organization_id, email, access_token, refresh_token, token_expires_at, status')
        .eq('organization_id', m.organization_id)
        .eq('provider', 'gmail')
        .maybeSingle()
      connections.set(m.organization_id, c && c.status === 'connected' ? (c as MailConnection) : null)
      const { count } = await service
        .from('outreach_messages')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', m.organization_id)
        .eq('source', 'automation')
        .gte('sent_at', startOfDay)
      sentToday.set(m.organization_id, count ?? 0)
    }
    const conn = connections.get(m.organization_id)
    if (!conn) {
      result.waiting_for_mailbox++ // stays queued until someone connects Gmail in Settings
      continue
    }
    if ((sentToday.get(m.organization_id) ?? 0) >= DAILY_SEND_CAP) continue // tomorrow

    // Claim it as sent first: the DB interlock re-checks do-not-contact / closed / meeting / PECR
    // right now, and the status change stops a concurrent run from sending it twice.
    const { data: claimed, error: claimError } = await service
      .from('outreach_messages')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .eq('id', m.id)
      .eq('status', 'queued')
      .select('id')
    if (claimError) {
      const reason = claimError.code === 'P0001' ? claimError.message : `could not claim: ${claimError.message}`
      await markMessageFailed(service, m.id, reason)
      if (m.follow_up_id && claimError.code === 'P0001') {
        await service.from('follow_ups').update({ status: 'skipped', reason }).eq('id', m.follow_up_id)
      }
      result.blocked++
      continue
    }
    if (!claimed?.length) continue // another run got it

    // Thread step 2+ with the earlier message.
    const { data: prior } = await service
      .from('outreach_messages')
      .select('subject, gmail_thread_id')
      .eq('lead_id', m.lead_id)
      .not('gmail_thread_id', 'is', null)
      .order('sent_at', { ascending: true })
      .limit(1)
      .maybeSingle()

    try {
      if (!m.to_email) throw new Error('no recipient address')
      const token = await getMailAccessToken(service, conn)
      const sent = await sendGmail(
        token,
        { from: conn.email, to: m.to_email, subject: threadedSubject(prior?.subject ?? null, m.subject ?? 'Following up'), body: m.body },
        prior?.gmail_thread_id ?? null
      )
      await service.from('outreach_messages').update({ gmail_message_id: sent.id, gmail_thread_id: sent.threadId, error_message: null }).eq('id', m.id)
      if (m.approval_id) await service.from('approvals').update({ status: 'executed' }).eq('id', m.approval_id)
      if (fu) {
        await service.from('follow_ups').update({ status: 'completed' }).eq('id', fu.id)
        const next = fu.step < MAX_AUTOMATED_STEPS ? scheduledSendTime(now, fu.step + 1) : null
        if (next) {
          // Interlocks may refuse (e.g. meeting booked since); that just ends the sequence.
          await service.from('follow_ups').insert({
            organization_id: m.organization_id,
            lead_id: m.lead_id,
            scheduled_for: next.toISOString(),
            reason: `Step ${fu.step + 1}: no reply yet`,
            status: 'pending',
            source: 'automation',
            step: fu.step + 1,
            decided_by: 'rule',
          })
        }
      }
      sentToday.set(m.organization_id, (sentToday.get(m.organization_id) ?? 0) + 1)
      result.sent++
    } catch (err) {
      await service.from('outreach_messages').update({ sent_at: null }).eq('id', m.id)
      await recordFailure(service, m, `send failed: ${err instanceof Error ? err.message : 'unknown error'}`)
      result.failed++
    }
  }
  return result
}
