import type { SupabaseClient } from '@supabase/supabase-js'

// Gmail for follow-ups: FlowLead sends from the org's connected Workspace mailbox and reads
// replies. Tokens live in public.mail_connections (service role only) and never leave the app.
// Spec: Obsidian SALES-OS/INTERNAL/FLOWLEAD_FOLLOWUPS_SPEC_2026-09-24.md

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  // Needed to see replies. Google classes it as a restricted scope: fine for your own
  // Workspace (internal app / test users), but selling FlowLead would need Google's review.
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
]

export const GMAIL_STATE_COOKIE = 'fl_gmail_oauth_state'

function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').split(',')[0].trim()
}

export function gmailRedirectUri(): string {
  return `${appUrl()}/api/auth/gmail/callback`
}

export function isGmailConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
}

export function getGmailAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? '',
    redirect_uri: gmailRedirectUri(),
    response_type: 'code',
    scope: GMAIL_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent', // always return a refresh token
    include_granted_scopes: 'false',
    state,
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
}

type TokenResponse = { access_token: string; refresh_token?: string; expires_in: number; scope?: string }

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      ...body,
    }),
  })
  if (!res.ok) throw new Error(`google_token_${res.status}`)
  return res.json() as Promise<TokenResponse>
}

export function exchangeGmailCode(code: string) {
  return tokenRequest({ code, redirect_uri: gmailRedirectUri(), grant_type: 'authorization_code' })
}

export async function getGoogleEmail(accessToken: string): Promise<string> {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`google_userinfo_${res.status}`)
  const data = (await res.json()) as { email?: string }
  if (!data.email) throw new Error('google_userinfo_no_email')
  return data.email
}

export async function revokeGoogleToken(token: string): Promise<void> {
  await fetch('https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
  }).catch(() => {})
}

export type MailConnection = {
  id: string
  organization_id: string
  email: string
  access_token: string
  refresh_token: string | null
  token_expires_at: string
  status: string
}

/** A usable access token for the org's mailbox, refreshing (and persisting) it when near expiry. */
export async function getMailAccessToken(service: SupabaseClient, conn: MailConnection): Promise<string> {
  if (new Date(conn.token_expires_at).getTime() - Date.now() > 60_000) return conn.access_token
  if (!conn.refresh_token) throw new Error('gmail_no_refresh_token')
  try {
    const t = await tokenRequest({ refresh_token: conn.refresh_token, grant_type: 'refresh_token' })
    const expires = new Date(Date.now() + t.expires_in * 1000).toISOString()
    await service
      .from('mail_connections')
      .update({ access_token: t.access_token, token_expires_at: expires, status: 'connected', last_error: null, updated_at: new Date().toISOString() })
      .eq('id', conn.id)
    return t.access_token
  } catch (err) {
    // A refused refresh means the user revoked access in Google; stop trying until reconnected.
    await service
      .from('mail_connections')
      .update({ status: 'error', last_error: String(err instanceof Error ? err.message : err), updated_at: new Date().toISOString() })
      .eq('id', conn.id)
    throw err
  }
}

/** Header-safe: strips CR/LF so a subject or name can never inject extra headers. */
function headerValue(v: string): string {
  return v.replace(/[\r\n]+/g, ' ').trim()
}

/** RFC 2047 encoding for non-ASCII header text (subjects with accents, emoji, etc.). */
function encodeHeader(v: string): string {
  const clean = headerValue(v)
  return /^[\x00-\x7F]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`
}

export type OutgoingEmail = {
  from: string
  to: string
  subject: string
  body: string // plain text only: no tracking pixels, no rewritten links (spec decision 2)
  inReplyTo?: string | null // RFC Message-ID of the previous message in the thread
}

/** Builds the base64url RFC 2822 message Gmail's send endpoint expects. Exported for tests. */
export function buildRawEmail(e: OutgoingEmail): string {
  const headers = [
    `From: ${headerValue(e.from)}`,
    `To: ${headerValue(e.to)}`,
    `Subject: ${encodeHeader(e.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ]
  if (e.inReplyTo) {
    headers.push(`In-Reply-To: ${headerValue(e.inReplyTo)}`, `References: ${headerValue(e.inReplyTo)}`)
  }
  const body = Buffer.from(e.body.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n')
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}`, 'utf8').toString('base64url')
}

export async function sendGmail(
  accessToken: string,
  email: OutgoingEmail,
  threadId?: string | null
): Promise<{ id: string; threadId: string }> {
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: buildRawEmail(email), ...(threadId ? { threadId } : {}) }),
  })
  if (!res.ok) throw new Error(`gmail_send_${res.status}`)
  return res.json() as Promise<{ id: string; threadId: string }>
}
