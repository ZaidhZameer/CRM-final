'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { GMAIL_SCOPES, isGmailConfigured, revokeGoogleToken } from '@/lib/gmail'

export type MailboxStatus = {
  configured: boolean // Google OAuth client set up on the server
  connected: boolean
  email: string | null
  status: 'connected' | 'revoked' | 'error' | null
  canReadReplies: boolean
  canManage: boolean // owner/admin
  lastError: string | null
}

async function context() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/sign-in')
  const service = createServiceClient()
  const { data: profile } = await service
    .from('profiles')
    .select('id, default_organization_id')
    .eq('user_id', user.id)
    .single()
  const orgId = profile?.default_organization_id ?? null
  const { data: membership } = orgId
    ? await service
        .from('memberships')
        .select('role')
        .eq('profile_id', profile!.id)
        .eq('organization_id', orgId)
        .eq('status', 'active')
        .maybeSingle()
    : { data: null }
  return { service, orgId, canManage: ['owner', 'admin'].includes(membership?.role ?? '') }
}

/** Connection status only. Tokens never leave the server. */
export async function getMailboxStatus(): Promise<MailboxStatus> {
  const { service, orgId, canManage } = await context()
  const base: MailboxStatus = {
    configured: isGmailConfigured(), connected: false, email: null, status: null,
    canReadReplies: false, canManage, lastError: null,
  }
  if (!orgId) return base
  const { data } = await service
    .from('mail_connections')
    .select('email, status, scopes, last_error')
    .eq('organization_id', orgId)
    .eq('provider', 'gmail')
    .maybeSingle()
  if (!data) return base
  return {
    ...base,
    connected: data.status === 'connected',
    email: data.email,
    status: data.status,
    canReadReplies: (data.scopes ?? []).includes(GMAIL_SCOPES[1]),
    lastError: canManage ? data.last_error : null,
  }
}

export async function disconnectMailbox(): Promise<{ error?: string }> {
  const { service, orgId, canManage } = await context()
  if (!orgId) return { error: 'No organization' }
  if (!canManage) return { error: 'Only owners and admins can disconnect the mailbox.' }
  const { data } = await service
    .from('mail_connections')
    .select('id, refresh_token, access_token')
    .eq('organization_id', orgId)
    .eq('provider', 'gmail')
    .maybeSingle()
  if (!data) return {}
  await revokeGoogleToken(data.refresh_token ?? data.access_token)
  await service.from('mail_connections').delete().eq('id', data.id)
  return {}
}

export type AutoReplySettings = { enabled: boolean; subject: string; body: string; canManage: boolean }

const DEFAULT_SUBJECT = 'Thanks for getting in touch, {first_name}'
const DEFAULT_BODY = "Hi {first_name},\n\nThanks for your message. I've got it and will get back to you personally today.\n\nBest,\n{sender_name}"

/** The instant-reply template for form enquiries (defaults until saved). */
export async function getAutoReply(): Promise<AutoReplySettings> {
  const { service, orgId, canManage } = await context()
  if (!orgId) return { enabled: false, subject: DEFAULT_SUBJECT, body: DEFAULT_BODY, canManage }
  const { data } = await service.from('auto_replies').select('enabled, subject, body').eq('organization_id', orgId).maybeSingle()
  return { enabled: data?.enabled ?? false, subject: data?.subject ?? DEFAULT_SUBJECT, body: data?.body ?? DEFAULT_BODY, canManage }
}

export async function saveAutoReply(input: { enabled: boolean; subject: string; body: string }): Promise<{ error?: string }> {
  const { service, orgId, canManage } = await context()
  if (!orgId) return { error: 'No organization' }
  if (!canManage) return { error: 'Only owners and admins can change the instant reply.' }
  const subject = input.subject.replace(/[\r\n]+/g, ' ').trim()
  const body = input.body.trim()
  if (!subject || subject.length > 300) return { error: 'Subject must be 1-300 characters.' }
  if (!body || body.length > 5000) return { error: 'Message must be 1-5000 characters.' }
  if (/<[a-z][\s\S]*>/i.test(body)) return { error: 'Plain text only: no HTML.' }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const { data: profile } = await service.from('profiles').select('id').eq('user_id', user?.id ?? '').maybeSingle()
  const { error } = await service.from('auto_replies').upsert({
    organization_id: orgId,
    enabled: input.enabled,
    subject,
    body,
    updated_by: profile?.id ?? null,
    updated_at: new Date().toISOString(),
  })
  return error ? { error: 'Could not save. Please try again.' } : {}
}
