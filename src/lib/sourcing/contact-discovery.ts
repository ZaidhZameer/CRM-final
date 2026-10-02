import { fetchPublicPage, type AuditOptions } from './site-audit'
import { normaliseCompanyName } from './names'

// Contact discovery (decision: wiki/decisions/2026-10-02-flowlead-agent-swarm-and-leadgen.md and the
// Jev pick "research then verify"). Companies House gives no website or email. The research step
// proposes a website; FlowLead VERIFIES it by fetching the page through the SSRF-safe fetcher and
// only accepts PUBLISHED addresses on the company's own domain. No SMTP probing, no guessing, no
// scraping of third-party sites, and by default only role addresses (info@, hello@...).

const ROLE_LOCALS = [
  'info', 'hello', 'enquiries', 'enquiry', 'contact', 'office', 'reception', 'admin', 'bookings', 'booking',
  'appointments', 'sales', 'team', 'support', 'mail', 'general',
]

const JUNK_DOMAINS = /(^|\.)(example\.(com|org|net)|sentry\.io|sentry-next\.wixpress\.com|wixpress\.com|domain\.com|email\.com|yourdomain\.com)$/i
const FILE_LIKE = /\.(png|jpe?g|gif|svg|webp|css|js|woff2?|ico)$/i

export type FoundEmail = { email: string; isRole: boolean }

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&commat;/gi, '@')
}

/** The site's base host without a leading www., e.g. "www.harbordental.co.uk" -> "harbordental.co.uk". */
export function baseHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '')
}

function sameCompanyDomain(emailDomain: string, siteHost: string): boolean {
  const e = emailDomain.toLowerCase()
  const h = baseHost(siteHost)
  return e === h || e.endsWith(`.${h}`) || h.endsWith(`.${e}`)
}

/**
 * Published email addresses on a page that belong to the company's own domain. Reads mailto links
 * and addresses printed in the text (including &#64; style obfuscation). Order is stable.
 */
export function extractPublishedEmails(html: string, siteHost: string): FoundEmail[] {
  const text = decodeEntities(html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' '))
  const found = new Set<string>()
  for (const m of text.matchAll(/mailto:([^"'\s>?]+)/gi)) found.add(decodeURIComponent(m[1]).trim().toLowerCase())
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g)) found.add(m[0].toLowerCase())

  const out: FoundEmail[] = []
  for (const email of found) {
    const [local, domain] = email.split('@')
    if (!local || !domain || FILE_LIKE.test(email) || JUNK_DOMAINS.test(domain)) continue
    if (!sameCompanyDomain(domain, siteHost)) continue
    out.push({ email, isRole: ROLE_LOCALS.includes(local.replace(/[._-].*$/, '')) })
  }
  return out
}

/** The best address to use: a role address in preference order. Personal addresses only if allowed. */
export function pickContactEmail(emails: FoundEmail[], allowPersonal = false): FoundEmail | null {
  const roles = emails.filter((e) => e.isRole).sort((a, b) => rank(a.email) - rank(b.email))
  if (roles.length) return roles[0]
  return allowPersonal ? (emails[0] ?? null) : null
}
const rank = (email: string) => {
  const i = ROLE_LOCALS.indexOf(email.split('@')[0].replace(/[._-].*$/, ''))
  return i === -1 ? 99 : i
}

/** First same-origin link that looks like a contact page, as an absolute URL. */
export function findContactPageUrl(html: string, base: URL): string | null {
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["'][^>]*>/gi)) {
    try {
      const u = new URL(decodeEntities(m[1]), base)
      if (u.origin !== base.origin) continue
      if (/(^|\/)(contact|contact-us|get-in-touch|enquir|enquiries|find-us)(\/|\.|$)/i.test(u.pathname)) return u.toString()
    } catch {
      /* ignore bad hrefs */
    }
  }
  return null
}

/**
 * Does this page plausibly belong to this company? Guards against a wrong website proposed by
 * research: the page must mention the company's name (all significant words) or its Companies
 * House number.
 */
export function siteMatchesCompany(html: string, companyName: string, companyNumber?: string | null): boolean {
  const text = decodeEntities(html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ')
  if (companyNumber && html.includes(companyNumber)) return true
  const words = normaliseCompanyName(companyName).split(' ').filter((w) => w.length > 2)
  return words.length > 0 && words.every((w) => text.includes(w))
}

export type DiscoveryResult =
  | { ok: true; website: string; email: FoundEmail | null; sourceUrl: string | null }
  | { ok: false; reason: 'unreachable' | 'blocked' | 'not_this_company' }

/**
 * Verifies a proposed website and looks for a published contact address (home page, then the
 * contact page if one is linked). Never throws.
 */
export async function discoverContact(
  website: string,
  company: { name: string; number?: string | null },
  opts: Pick<AuditOptions, 'fetch' | 'resolveHost' | 'timeoutMs' | 'maxBytes'> = {}
): Promise<DiscoveryResult> {
  const home = await fetchPublicPage(website, opts)
  if (!home.ok) return { ok: false, reason: home.error.kind === 'blocked_host' || home.error.kind === 'invalid_url' ? 'blocked' : 'unreachable' }

  const host = home.finalUrl.hostname
  const pages: { html: string; url: string }[] = [{ html: home.html, url: home.finalUrl.toString() }]

  const contactUrl = findContactPageUrl(home.html, home.finalUrl)
  if (contactUrl) {
    const page = await fetchPublicPage(contactUrl, opts)
    if (page.ok) pages.push({ html: page.html, url: page.finalUrl.toString() })
  }

  // The home page or contact page must be about THIS company.
  if (!pages.some((p) => siteMatchesCompany(p.html, company.name, company.number))) return { ok: false, reason: 'not_this_company' }

  for (const p of pages) {
    const picked = pickContactEmail(extractPublishedEmails(p.html, host))
    if (picked) return { ok: true, website: `${home.finalUrl.protocol}//${host}`, email: picked, sourceUrl: p.url }
  }
  return { ok: true, website: `${home.finalUrl.protocol}//${host}`, email: null, sourceUrl: null }
}
