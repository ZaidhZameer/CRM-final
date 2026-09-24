import type { SupabaseClient } from '@supabase/supabase-js'

// Statuses where a lead is finished: a new enquiry from the same person starts a fresh lead.
const CLOSED_STATUSES = ['converted', 'lost', 'unqualified']

// Consumer mailboxes say nothing about the company, so they never become a website.
const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com',
  'live.co.uk', 'msn.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'icloud.com', 'me.com',
  'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.co.uk', 'zoho.com',
  'mail.com', 'btinternet.com', 'sky.com', 'virginmedia.com', 'talktalk.net',
])

/** https://<domain> for a business email address, otherwise null. Free signal for enrichment. */
export function websiteFromEmail(email: string | null | undefined): string | null {
  const domain = email?.trim().toLowerCase().split('@')[1]
  if (!domain || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return null
  if (FREE_MAIL_DOMAINS.has(domain)) return null
  // Reserved/test domains (RFC 2606) never have a real site behind them.
  if (/(^|\.)(example\.(com|org|net)|test|invalid|localhost)$/.test(domain)) return null
  return `https://${domain}`
}

/**
 * The id of an open (not closed, not deleted) lead in this org whose contact has this email,
 * so a repeat enquiry updates the existing lead instead of creating a duplicate.
 */
export async function findOpenLeadIdByEmail(
  service: SupabaseClient,
  orgId: string,
  email: string | null | undefined
): Promise<string | null> {
  const clean = email?.trim()
  if (!clean) return null

  const { data: contacts } = await service
    .from('contacts')
    .select('id')
    .eq('organization_id', orgId)
    .ilike('email', clean)
    .limit(20)
  if (!contacts?.length) return null

  const { data: lead } = await service
    .from('leads')
    .select('id')
    .eq('organization_id', orgId)
    .in('contact_id', contacts.map((c) => c.id))
    .is('deleted_at', null)
    .not('status', 'in', `(${CLOSED_STATUSES.map((s) => `"${s}"`).join(',')})`)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  return lead?.id ?? null
}
