import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getMailAccessToken, GMAIL_SCOPES, type MailConnection } from '@/lib/gmail'

// Picks up replies to FlowLead's follow-ups from the connected Gmail mailbox (history API).
// Only threads FlowLead started are looked at. Every real reply stops the sequence and becomes a
// task for a human; "stop"/unsubscribe also sets do-not-contact; out-of-office just pushes the
// next step back. Spec: Obsidian SALES-OS/INTERNAL/FLOWLEAD_FOLLOWUPS_SPEC_2026-09-24.md (step 5).

export type ReplyClass = 'unsubscribe' | 'out_of_office' | 'other'

const OPT_OUT = /\b(stop|unsubscribe|remove me|take me off|opt[- ]?out|don'?t (contact|email) me|do not (contact|email) me|no more emails)\b/i
const AUTO_SUBJECT = /\b(out of (the )?office|automatic reply|auto[- ]?reply|autoreply|away from (the )?office|on (annual )?leave|on holiday)\b/i

/**
 * Deterministic, free classification of what changes behaviour. Anything else ("interested",
 * "not now", questions) is 'other' and goes to a human, who answers every real reply anyway.
 */
export function classifyReply(input: { subject?: string | null; snippet?: string | null; autoSubmitted?: string | null }): ReplyClass {
  const auto = (input.autoSubmitted ?? '').toLowerCase()
  if ((auto && auto !== 'no') || AUTO_SUBJECT.test(input.subject ?? '')) return 'out_of_office'
  // Only the start of the reply: quoted history below it contains our own opt-out line.
  const opening = (input.snippet ?? '').split(/\bOn .{5,80} wrote:|^>/m)[0].slice(0, 300)
  if (OPT_OUT.test(opening)) return 'unsubscribe'
  return 'other'
}

/** Stable UUID for a Gmail message, so the same reply is only ever processed once. */
export function replyEventId(orgId: string, gmailMessageId: string): string {
  const h = createHash('sha256').update(`reply:${orgId}:${gmailMessageId}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${(8 + (parseInt(h[16], 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

async function gmailGet<T>(token: string, path: string): Promise<{ status: number; data: T | null }> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { headers: { Authorization: `Bearer ${token}` } })
  return { status: res.status, data: res.ok ? ((await res.json()) as T) : null }
}

type HistoryPage = { history?: { messagesAdded?: { message: { id: string; threadId: string; labelIds?: string[] } }[] }[]; historyId?: string; nextPageToken?: string }
type GmailMessage = { id: string; threadId: string; snippet?: string; labelIds?: string[]; payload?: { headers?: { name: string; value: string }[] } }

export type ReplyInput = { gmailMessageId: string; threadId: string; from: string; subject: string | null; snippet: string | null; autoSubmitted: string | null }

/** Applies one inbound reply. Exported so the logic can be tested without Gmail. */
export async function applyReply(service: SupabaseClient, conn: Pick<MailConnection, 'organization_id'> & { profile_id?: string | null }, r: ReplyInput): Promise<'applied' | 'duplicate' | 'not_ours'> {
  const orgId = conn.organization_id
  const { data: outbound } = await service
    .from('outreach_messages')
    .select('id, lead_id, to_email')
    .eq('organization_id', orgId)
    .eq('gmail_thread_id', r.threadId)
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!outbound) return 'not_ours'

  // Process each Gmail message once, even across overlapping cron runs.
  const { error: claim } = await service.from('automation_events').insert({
    event_id: replyEventId(orgId, r.gmailMessageId),
    organization_id: orgId,
    lead_id: outbound.lead_id,
    direction: 'inbound',
    event_type: 'reply.received',
    status: 'processing',
  })
  if (claim) {
    if (claim.code === '23505') return 'duplicate'
    throw new Error(claim.message)
  }

  const cls = classifyReply(r)
  const now = new Date().toISOString()

  if (cls === 'out_of_office') {
    // Not a real reply: keep the sequence, just move the next step back a week.
    const { data: pending } = await service
      .from('follow_ups')
      .select('id, scheduled_for')
      .eq('lead_id', outbound.lead_id)
      .eq('status', 'pending')
      .maybeSingle()
    if (pending) {
      const later = new Date(Math.max(Date.now(), new Date(pending.scheduled_for).getTime()) + 7 * 24 * 60 * 60_000).toISOString()
      await service.from('follow_ups').update({ scheduled_for: later, reason: 'Pushed back: out-of-office auto-reply' }).eq('id', pending.id)
    }
  } else {
    await service.from('outreach_messages').update({ status: 'replied', replied_at: now, reply_class: cls }).eq('id', outbound.id)
    // Any real reply ends the automated sequence: a human answers from here.
    await service
      .from('follow_ups')
      .update({ status: 'skipped', reason: 'Lead replied', decided_by: 'rule' })
      .eq('lead_id', outbound.lead_id)
      .eq('status', 'pending')
    if (cls === 'unsubscribe') await service.from('leads').update({ do_not_contact: true }).eq('id', outbound.lead_id)

    await service.from('tasks').insert({
      organization_id: orgId,
      lead_id: outbound.lead_id,
      title: cls === 'unsubscribe' ? `Opted out: ${r.from}`.slice(0, 200) : `Reply from ${r.from}: answer it`.slice(0, 200),
      description: [
        cls === 'unsubscribe' ? 'They asked not to be contacted again. Do-not-contact is now on; no action needed unless they asked something.' : 'Follow-ups have stopped. Reply personally.',
        '',
        `Subject: ${r.subject ?? ''}`,
        `"${(r.snippet ?? '').slice(0, 500)}"`,
      ].join('\n'),
      priority: cls === 'unsubscribe' ? 'low' : 'high',
      status: 'todo',
      due_at: new Date(Date.now() + (cls === 'unsubscribe' ? 24 : 2) * 60 * 60_000).toISOString(),
      assigned_to: conn.profile_id ?? null,
    })
  }

  await service.from('automation_events').update({ status: 'completed', result_json: { class: cls } }).eq('event_id', replyEventId(orgId, r.gmailMessageId))
  return 'applied'
}

/** Reads new mail since the stored cursor for every connected mailbox that may read replies. */
export async function watchReplies(service: SupabaseClient) {
  const summary = { mailboxes: 0, replies: 0, errors: 0 }
  const { data: conns } = await service
    .from('mail_connections')
    .select('id, organization_id, profile_id, email, access_token, refresh_token, token_expires_at, status, scopes, last_history_id')
    .eq('provider', 'gmail')
    .eq('status', 'connected')

  for (const c of conns ?? []) {
    if (!(c.scopes ?? []).includes(GMAIL_SCOPES[1])) continue
    summary.mailboxes++
    try {
      const token = await getMailAccessToken(service, c as MailConnection)
      if (!c.last_history_id) {
        // First run: start from now; older mail is not our business.
        const { data: profile } = await gmailGet<{ historyId: string }>(token, 'profile')
        if (profile) await service.from('mail_connections').update({ last_history_id: profile.historyId }).eq('id', c.id)
        continue
      }

      let pageToken: string | undefined
      const start = c.last_history_id as string // fixed for every page of this listing
      let latest = start
      do {
        const q = new URLSearchParams({ startHistoryId: start, historyTypes: 'messageAdded', maxResults: '100' })
        if (pageToken) q.set('pageToken', pageToken)
        const { status, data } = await gmailGet<HistoryPage>(token, `history?${q}`)
        if (status === 404) {
          // Cursor too old (Gmail keeps about a week): restart from now.
          const { data: profile } = await gmailGet<{ historyId: string }>(token, 'profile')
          if (profile) latest = profile.historyId
          break
        }
        if (!data) throw new Error(`gmail_history_${status}`)

        for (const h of data.history ?? []) {
          for (const added of h.messagesAdded ?? []) {
            const labels = added.message.labelIds ?? []
            if (labels.includes('SENT') || labels.includes('DRAFT')) continue // our own mail
            const { data: msg } = await gmailGet<GmailMessage>(
              token,
              `messages/${added.message.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Auto-Submitted`
            )
            if (!msg) continue
            const header = (n: string) => msg.payload?.headers?.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value ?? null
            const outcome = await applyReply(service, c, {
              gmailMessageId: msg.id,
              threadId: msg.threadId,
              from: header('From') ?? 'unknown sender',
              subject: header('Subject'),
              snippet: msg.snippet ?? null,
              autoSubmitted: header('Auto-Submitted'),
            })
            if (outcome === 'applied') summary.replies++
          }
        }
        if (data.historyId) latest = data.historyId
        pageToken = data.nextPageToken
      } while (pageToken)

      await service.from('mail_connections').update({ last_history_id: latest }).eq('id', c.id)
    } catch (err) {
      summary.errors++
      console.error('[replies] mailbox check failed', c.id, err instanceof Error ? err.message : err)
    }
  }
  return summary
}
