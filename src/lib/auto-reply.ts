import type { SupabaseClient } from '@supabase/supabase-js'
import { getMailAccessToken, sendGmail, type MailConnection } from '@/lib/gmail'
import { DAILY_SEND_CAP } from '@/lib/follow-up-sender'

// Instant acknowledgement of a form enquiry, sent from the connected mailbox within seconds.
// The owner approved the template once (Settings) instead of approving each email.
// Never to do-not-contact leads (DB interlock), at most once per lead per day, and it counts
// towards the mailbox's daily automated-send cap.

export type TemplateVars = { first_name?: string | null; company?: string | null; sender_name?: string | null }

/** Fills {first_name}, {company} and {sender_name}; unknown values read naturally. Exported for tests. */
export function renderTemplate(template: string, vars: TemplateVars): string {
  const first = (vars.first_name ?? '').trim().split(/\s+/)[0]
  // A placeholder-looking or test-looking "name" should not be used as a greeting.
  const firstName = first && /^[A-Za-zÀ-ÿ'-]{2,}$/.test(first) && !/^(test|unknown|n\/a|na|none)$/i.test(first) ? first : 'there'
  return template
    .replace(/\{first_name\}/g, firstName)
    .replace(/\{company\}/g, (vars.company ?? '').trim() || 'your team')
    .replace(/\{sender_name\}/g, (vars.sender_name ?? '').trim() || 'The team')
    .replace(/[ \t]+\n/g, '\n')
}

export type AckInput = { organizationId: string; leadId: string; email: string | null; fullName: string | null; companyName: string | null }

/** Sends the acknowledgement if it's switched on and a mailbox is connected. Never throws. */
export async function sendEnquiryAcknowledgement(service: SupabaseClient, input: AckInput): Promise<'sent' | 'off' | 'no_mailbox' | 'skipped' | 'failed'> {
  try {
    if (!input.email) return 'skipped'
    const { data: settings } = await service
      .from('auto_replies')
      .select('enabled, subject, body')
      .eq('organization_id', input.organizationId)
      .maybeSingle()
    if (!settings?.enabled) return 'off'

    const { data: conn } = await service
      .from('mail_connections')
      .select('id, organization_id, email, access_token, refresh_token, token_expires_at, status')
      .eq('organization_id', input.organizationId)
      .eq('provider', 'gmail')
      .maybeSingle()
    if (!conn || conn.status !== 'connected') return 'no_mailbox'

    const dayAgo = new Date(Date.now() - 24 * 60 * 60_000).toISOString()
    const startOfDay = new Date(new Date().setHours(0, 0, 0, 0)).toISOString()
    const [{ count: recentToLead }, { count: sentToday }, { data: owner }] = await Promise.all([
      service.from('outreach_messages').select('id', { count: 'exact', head: true }).eq('lead_id', input.leadId).eq('source', 'automation').gte('created_at', dayAgo),
      service.from('outreach_messages').select('id', { count: 'exact', head: true }).eq('organization_id', input.organizationId).eq('source', 'automation').gte('sent_at', startOfDay),
      service.from('memberships').select('profiles(full_name)').eq('organization_id', input.organizationId).eq('role', 'owner').eq('status', 'active').limit(1).maybeSingle(),
    ])
    if (recentToLead) return 'skipped' // already acknowledged (repeat enquiry)
    if ((sentToday ?? 0) >= DAILY_SEND_CAP) return 'skipped'

    const vars = {
      first_name: input.fullName,
      company: input.companyName,
      sender_name: ((owner?.profiles ?? null) as unknown as { full_name: string | null } | null)?.full_name ?? null,
    }
    const subject = renderTemplate(settings.subject, vars).replace(/[\r\n]+/g, ' ').slice(0, 300)
    const body = renderTemplate(settings.body, vars)

    // Inserting as 'sent' runs the outreach interlock now: do-not-contact / PECR block it here.
    const { data: msg, error } = await service
      .from('outreach_messages')
      .insert({
        organization_id: input.organizationId,
        lead_id: input.leadId,
        channel: 'email',
        status: 'sent',
        source: 'automation',
        to_email: input.email,
        subject,
        body,
        sent_at: new Date().toISOString(),
      })
      .select('id')
      .single()
    if (error || !msg) return 'skipped'

    try {
      const token = await getMailAccessToken(service, conn as MailConnection)
      const sent = await sendGmail(token, { from: conn.email, to: input.email, subject, body })
      await service.from('outreach_messages').update({ gmail_message_id: sent.id, gmail_thread_id: sent.threadId }).eq('id', msg.id)
      return 'sent'
    } catch (err) {
      const reason = `acknowledgement not sent: ${err instanceof Error ? err.message : 'unknown error'}`
      await service.from('outreach_messages').update({ status: 'failed', sent_at: null, error_message: reason }).eq('id', msg.id)
      await service.from('jobs').insert({
        organization_id: input.organizationId,
        job_type: 'enquiry.ack',
        subject_type: 'lead',
        subject_id: input.leadId,
        status: 'failed',
        finished_at: new Date().toISOString(),
        error_message: reason,
      })
      return 'failed'
    }
  } catch (err) {
    console.error('[auto-reply] crashed', err instanceof Error ? err.message : err)
    return 'failed'
  }
}
