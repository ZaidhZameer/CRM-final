import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/**
 * Website audit for lead sourcing: fetches a prospect's homepage safely (SSRF-guarded),
 * runs simple documented HTML heuristics, optionally adds a PageSpeed Insights mobile score,
 * and turns the result into at most 3 plain-English, business-impact findings.
 * Never throws; failures come back as `{ ok: false, error }`.
 */

export type Severity = 'high' | 'medium' | 'low'

export type Finding = {
  code: string
  severity: Severity
  /** Plain-English, business-impact sentence suitable for outreach copy. */
  message: string
}

export type CmsStatus = 'current' | 'outdated' | 'none_detected'

export type AuditSignals = {
  finalUrl: string
  https: boolean
  hasViewport: boolean
  hasContactForm: boolean
  hasBookingWidget: boolean
  /** Latest copyright year found in the page, or null. */
  copyrightYear: number | null
  /** Raw <meta name="generator"> content, if any. */
  generator: string | null
  cmsStatus: CmsStatus
  /** PageSpeed mobile performance score 0-100, or null when unavailable. */
  mobileScore: number | null
  /** True when the body hit the size cap and was cut short. */
  truncated: boolean
}

export type AuditError =
  | { kind: 'invalid_url'; message: string }
  | { kind: 'blocked_host'; message: string }
  | { kind: 'timeout'; message: string }
  | { kind: 'http_error'; message: string; status: number }
  | { kind: 'not_html'; message: string }
  | { kind: 'fetch_failed'; message: string }

export type AuditResult =
  | { ok: true; findings: Finding[]; signals: AuditSignals }
  | { ok: false; error: AuditError }

export type AuditOptions = {
  fetch?: typeof fetch
  /** Resolves a hostname to its IP addresses (for SSRF checks). Defaults to dns.lookup. */
  resolveHost?: (hostname: string) => Promise<string[]>
  /** Defaults to process.env.PAGESPEED_API_KEY. Optional; never logged. */
  pageSpeedApiKey?: string
  /** Set false to skip PageSpeed entirely (default true). */
  usePageSpeed?: boolean
  /** Whole-fetch deadline for the HTML (default 8000ms). */
  timeoutMs?: number
  /** PageSpeed deadline (default 25000ms). */
  pageSpeedTimeoutMs?: number
  /** Max HTML bytes read (default 512 KiB). */
  maxBytes?: number
  maxRedirects?: number
  /** Injectable clock for the copyright-age rule. */
  now?: () => Date
}

const USER_AGENT = 'FlowLead-SiteAudit/1.0 (website review for sales outreach)'
const DEFAULT_TIMEOUT_MS = 8_000
const DEFAULT_PSI_TIMEOUT_MS = 25_000
const DEFAULT_MAX_BYTES = 512 * 1024
const DEFAULT_MAX_REDIRECTS = 3
const MAX_FINDINGS = 3

/* ------------------------------------------------------------------ */
/* SSRF protection                                                     */
/* ------------------------------------------------------------------ */

function ipv4ToParts(ip: string): number[] | null {
  const p = ip.split('.').map(Number)
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? p : null
}

function isPrivateIPv4(ip: string): boolean {
  const p = ipv4ToParts(ip)
  if (!p) return true // unparseable: fail closed
  const [a, b] = p
  return (
    a === 0 || // "this" network
    a === 10 ||
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, incl. cloud metadata 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && p[2] === 0) || // IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast / reserved / broadcast
  )
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase().split('%')[0]
  // IPv4-mapped (::ffff:a.b.c.d or ::ffff:7f00:1): judge by the embedded IPv4.
  const mapped = lower.match(/^(?:0:0:0:0:0:|::)ffff:(.+)$/)
  if (mapped) {
    const rest = mapped[1]
    if (rest.includes('.')) return isPrivateIPv4(rest)
    const hex = rest.split(':')
    if (hex.length === 2) {
      const hi = parseInt(hex[0], 16)
      const lo = parseInt(hex[1], 16)
      return isPrivateIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
    }
    return true
  }
  const first = lower.startsWith('::') ? 0 : parseInt(lower.split(':')[0] || '0', 16)
  if (Number.isNaN(first)) return true
  return (
    first === 0 || // ::, ::1, IPv4-compatible
    first === 0x64 || // 64:ff9b::/96 NAT64
    (first >= 0xfc00 && first <= 0xfdff) || // unique local
    (first >= 0xfe80 && first <= 0xfebf) || // link-local
    first >= 0xff00 || // multicast
    (first === 0x2001 && lower.startsWith('2001:db8')) // documentation
  )
}

/** True when an IP literal (v4 or v6) is loopback, private, link-local, reserved or otherwise internal. */
export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) return isPrivateIPv4(ip)
  if (v === 6) return isPrivateIPv6(ip)
  return true
}

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa', '.lan', '.intranet']

function hostnameLooksInternal(host: string): boolean {
  if (host === 'localhost') return true
  if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return true
  return !host.includes('.') // single-label names resolve on internal networks
}

/**
 * Normalises and validates a URL for outbound fetching.
 * Accepts bare domains ("example.co.uk" becomes https://example.co.uk/). Only http/https on
 * ports 80/443, no embedded credentials, and no internal hostnames or private/loopback IP literals.
 * Name-based hosts are additionally resolved at fetch time (see `assertPublicHost`).
 */
export function validateAuditUrl(
  raw: string
): { ok: true; url: URL } | { ok: false; error: AuditError } {
  const input = raw.trim()
  if (!input) return { ok: false, error: { kind: 'invalid_url', message: 'URL is empty' } }
  // Bare domain => https. Anything with an explicit scheme (file:, ftp:, javascript:) is parsed as-is and rejected below.
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(input) && !/^[^/]*:\d+(\/|$)/.test(input) ? input : `https://${input}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return { ok: false, error: { kind: 'invalid_url', message: 'URL could not be parsed' } }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: { kind: 'invalid_url', message: 'Only http and https URLs are allowed' } }
  }
  if (url.username || url.password) {
    return { ok: false, error: { kind: 'invalid_url', message: 'URLs with credentials are not allowed' } }
  }
  if (url.port && url.port !== '80' && url.port !== '443') {
    return { ok: false, error: { kind: 'blocked_host', message: 'Non-standard ports are not allowed' } }
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '')
  if (!host) return { ok: false, error: { kind: 'invalid_url', message: 'URL has no host' } }
  if (isIP(host)) {
    if (isPrivateIp(host)) {
      return { ok: false, error: { kind: 'blocked_host', message: 'Private or loopback addresses are not allowed' } }
    }
  } else if (hostnameLooksInternal(host)) {
    return { ok: false, error: { kind: 'blocked_host', message: 'Internal hostnames are not allowed' } }
  }
  return { ok: true, url }
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const res = await lookup(hostname, { all: true })
  return res.map((r) => r.address)
}

/** Resolves name-based hosts and rejects if ANY address is internal (guards DNS pointing at private ranges). */
async function assertPublicHost(url: URL, resolve: (h: string) => Promise<string[]>): Promise<AuditError | null> {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) return null // literal already vetted by validateAuditUrl
  let addrs: string[]
  try {
    addrs = await resolve(host)
  } catch {
    return { kind: 'fetch_failed', message: 'Domain could not be resolved' }
  }
  if (addrs.length === 0) return { kind: 'fetch_failed', message: 'Domain could not be resolved' }
  if (addrs.some(isPrivateIp)) {
    return { kind: 'blocked_host', message: 'Domain resolves to a private or loopback address' }
  }
  return null
}

/* ------------------------------------------------------------------ */
/* Safe fetch                                                          */
/* ------------------------------------------------------------------ */

async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: '', truncated: false }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.byteLength
    if (total >= maxBytes) {
      truncated = true
      await reader.cancel().catch(() => undefined)
      break
    }
  }
  const buf = new Uint8Array(Math.min(total, maxBytes))
  let off = 0
  for (const c of chunks) {
    const slice = c.subarray(0, Math.max(0, buf.length - off))
    buf.set(slice, off)
    off += slice.length
  }
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(buf), truncated }
}

type Fetched = { html: string; finalUrl: URL; truncated: boolean }

async function fetchHtml(
  start: URL,
  o: Required<Pick<AuditOptions, 'timeoutMs' | 'maxBytes' | 'maxRedirects'>> & {
    doFetch: typeof fetch
    resolve: (h: string) => Promise<string[]>
  }
): Promise<{ ok: true; data: Fetched } | { ok: false; error: AuditError }> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, o.timeoutMs)

  try {
    let current = start
    for (let hop = 0; hop <= o.maxRedirects; hop++) {
      const blocked = await assertPublicHost(current, o.resolve)
      if (blocked) return { ok: false, error: blocked }

      const res = await o.doFetch(current.toString(), {
        method: 'GET',
        redirect: 'manual', // every hop is re-validated
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      })

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location')
        await res.body?.cancel().catch(() => undefined)
        if (!loc) return { ok: false, error: { kind: 'http_error', status: res.status, message: 'Redirect without a location' } }
        const next = validateAuditUrl(new URL(loc, current).toString())
        if (!next.ok) return { ok: false, error: next.error }
        current = next.url
        continue
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined)
        return { ok: false, error: { kind: 'http_error', status: res.status, message: `Site returned HTTP ${res.status}` } }
      }
      const ctype = res.headers.get('content-type')
      if (ctype && !/html|xml/i.test(ctype)) {
        await res.body?.cancel().catch(() => undefined)
        return { ok: false, error: { kind: 'not_html', message: 'Page is not HTML' } }
      }
      const { text, truncated } = await readCapped(res, o.maxBytes)
      return { ok: true, data: { html: text, finalUrl: current, truncated } }
    }
    return { ok: false, error: { kind: 'fetch_failed', message: 'Too many redirects' } }
  } catch {
    return timedOut
      ? { ok: false, error: { kind: 'timeout', message: 'Site took too long to respond' } }
      : { ok: false, error: { kind: 'fetch_failed', message: 'Site could not be fetched' } }
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ */
/* HTML heuristics (documented, deliberately simple)                   */
/* ------------------------------------------------------------------ */

/** Mobile-friendly if a viewport meta tag sets width=device-width. */
export function detectViewport(html: string): boolean {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? []
  return tags.some((t) => /name\s*=\s*["']?viewport/i.test(t) && /width\s*=\s*device-width/i.test(t))
}

const FORM_EMBEDS = /(typeform\.com|jotform\.com|wufoo\.com|formspree\.io|hsforms\.|hubspot\.com\/embed|cognitoforms\.com|gravityforms|wpcf7|wpforms|formsubmit\.co|tally\.so)/i

/**
 * Contact form: a <form> that has a textarea, an email input, or a field named email/message/enquiry
 * (search and login-only forms are ignored), or a known third-party form embed.
 */
export function detectContactForm(html: string): boolean {
  if (FORM_EMBEDS.test(html)) return true
  const forms = html.match(/<form\b[\s\S]*?<\/form>/gi) ?? []
  return forms.some((f) => {
    if (/role\s*=\s*["']?search/i.test(f) || /type\s*=\s*["']?search/i.test(f)) return false
    return (
      /<textarea\b/i.test(f) ||
      /type\s*=\s*["']?email/i.test(f) ||
      /(name|id)\s*=\s*["'][^"']*(email|message|enquir|inquir)/i.test(f)
    )
  })
}

const BOOKING_PROVIDERS =
  /(calendly\.com|setmore\.com|fresha\.com|treatwell\.|simplybook\.|acuityscheduling\.com|squareup\.com\/appointments|square\.site\/appointments|opentable\.|resdiary\.com|bookingkit|timetap\.com|mindbodyonline\.com|dentally|oneclickbook|vagaro\.com|booksy\.com|zenoti\.com|youcanbook\.me|tidycal\.com|hubspot\.com\/meetings)/i
const BOOKING_PHRASES = /\bbook\s+(?:now|online|an?\s+(?:appointment|table|consultation|call|visit|slot)|your\s+(?:appointment|table|visit|slot))\b/i

/** Online booking: a known booking-provider domain, or an explicit "book online / book an appointment" call to action. */
export function detectBooking(html: string): boolean {
  return BOOKING_PROVIDERS.test(html) || BOOKING_PHRASES.test(html)
}

/** Latest year in any "© 2019", "Copyright 2015-2019", "&copy; 2018" style notice, or null. */
export function detectCopyrightYear(html: string): number | null {
  const re = /(?:©|&copy;|&#169;|&#xa9;|copyright)\s*(?:\(c\)\s*)?(?:(?:19|20)\d{2}\s*(?:[-–—]|&ndash;|&mdash;|to)\s*)?((?:19|20)\d{2})\b/gi
  let max: number | null = null
  for (const m of html.matchAll(re)) {
    const y = Number(m[1])
    if (max === null || y > max) max = y
  }
  return max
}

export function detectGenerator(html: string): string | null {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? []
  for (const t of tags) {
    if (/name\s*=\s*["']?generator/i.test(t)) {
      const c = t.match(/content\s*=\s*["']([^"']*)["']/i)
      if (c && c[1].trim()) return c[1].trim()
    }
  }
  return null
}

const MODERN_PLATFORM_HINTS = /(wp-content|wp-includes|cdn\.shopify\.com|wixstatic\.com|squarespace|webflow|static\.parastorage\.com|godaddy|weebly|framer|_next\/|__NEXT_DATA__|hubspot)/i

/**
 * CMS status from the generator tag + platform fingerprints:
 *  - outdated: WordPress < 6.0, Joomla < 4, Drupal < 9, or 1990s/2000s page editors (FrontPage, Dreamweaver, Word)
 *  - current: a generator or platform fingerprint that isn't known to be outdated
 *  - none_detected: neither (hand-built or hidden; treated as a weak signal only)
 */
export function detectCmsStatus(html: string, generator: string | null): CmsStatus {
  if (generator) {
    const g = generator.toLowerCase()
    const ver = (name: string): number | null => {
      const m = g.match(new RegExp(`${name}\\s*v?(\\d+)`))
      return m ? Number(m[1]) : null
    }
    if (/frontpage|dreamweaver|microsoft word|nvu|iweb/.test(g)) return 'outdated'
    const wp = ver('wordpress')
    if (g.includes('wordpress') && wp !== null && wp < 6) return 'outdated'
    const joomla = ver('joomla!?')
    if (g.includes('joomla') && joomla !== null && joomla < 4) return 'outdated'
    const drupal = ver('drupal')
    if (g.includes('drupal') && drupal !== null && drupal < 9) return 'outdated'
    return 'current'
  }
  return MODERN_PLATFORM_HINTS.test(html) ? 'current' : 'none_detected'
}

/* ------------------------------------------------------------------ */
/* PageSpeed Insights (optional)                                       */
/* ------------------------------------------------------------------ */

/** Mobile performance score 0-100, or null on any failure/timeout. */
async function fetchMobileScore(
  url: string,
  o: { doFetch: typeof fetch; apiKey?: string; timeoutMs: number }
): Promise<number | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), o.timeoutMs)
  try {
    const q = new URLSearchParams({ url, strategy: 'mobile', category: 'performance' })
    if (o.apiKey) q.set('key', o.apiKey)
    const res = await o.doFetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${q.toString()}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return null
    const body: unknown = await res.json()
    const score = (body as { lighthouseResult?: { categories?: { performance?: { score?: unknown } } } })
      ?.lighthouseResult?.categories?.performance?.score
    return typeof score === 'number' && score >= 0 && score <= 1 ? Math.round(score * 100) : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ */
/* Findings                                                            */
/* ------------------------------------------------------------------ */

const SEVERITY_WEIGHT: Record<Severity, number> = { high: 3, medium: 2, low: 1 }

/** Turns signals into plain-English business-impact findings, ranked by severity (then fixed priority), max 3. */
export function buildFindings(s: AuditSignals, currentYear: number): Finding[] {
  const all: Finding[] = []
  if (!s.https) {
    all.push({
      code: 'no_https',
      severity: 'high',
      message:
        "Your website isn't secured with HTTPS, so browsers label it \"Not secure\" and many visitors will leave before they get in touch.",
    })
  }
  if (!s.hasViewport) {
    all.push({
      code: 'not_mobile_friendly',
      severity: 'high',
      message: "Your site isn't mobile-friendly, so most visitors on phones see a shrunken desktop page.",
    })
  }
  if (s.mobileScore !== null && s.mobileScore < 75) {
    all.push({
      code: 'slow_on_mobile',
      severity: s.mobileScore < 50 ? 'high' : 'medium',
      message: `Your site scores ${s.mobileScore}/100 for speed on mobile, so people searching on their phones are likely to give up waiting before they enquire.`,
    })
  }
  if (!s.hasContactForm && !s.hasBookingWidget) {
    all.push({
      code: 'no_easy_contact',
      severity: 'medium',
      message:
        "There's no contact form or online booking on your homepage, so visitors who aren't ready to phone have no easy way to reach you.",
    })
  }
  if (s.cmsStatus === 'outdated') {
    all.push({
      code: 'outdated_platform',
      severity: 'medium',
      message: `Your site is built on an outdated platform (${s.generator ?? 'old software'}) that no longer gets security updates, which puts your site and your customers' trust at risk.`,
    })
  }
  if (s.copyrightYear !== null && s.copyrightYear < currentYear - 2) {
    all.push({
      code: 'stale_copyright',
      severity: 'low',
      message: `Your footer still says © ${s.copyrightYear}, which makes the business look inactive to new visitors.`,
    })
  }
  if (s.cmsStatus === 'none_detected') {
    all.push({
      code: 'no_cms',
      severity: 'low',
      message:
        "Your site doesn't appear to run on a modern website platform, so even small updates like new opening hours probably need a developer.",
    })
  }
  return all
    .map((f, i) => ({ f, i }))
    .sort((a, b) => SEVERITY_WEIGHT[b.f.severity] - SEVERITY_WEIGHT[a.f.severity] || a.i - b.i)
    .slice(0, MAX_FINDINGS)
    .map((x) => x.f)
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export async function auditWebsite(rawUrl: string, opts: AuditOptions = {}): Promise<AuditResult> {
  try {
    const v = validateAuditUrl(rawUrl)
    if (!v.ok) return { ok: false, error: v.error }

    const doFetch = opts.fetch ?? fetch
    const fetched = await fetchHtml(v.url, {
      doFetch,
      resolve: opts.resolveHost ?? defaultResolve,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
      maxRedirects: opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
    })
    if (!fetched.ok) return { ok: false, error: fetched.error }
    const { html, finalUrl, truncated } = fetched.data

    const mobileScore =
      opts.usePageSpeed === false
        ? null
        : await fetchMobileScore(finalUrl.toString(), {
            doFetch,
            apiKey: opts.pageSpeedApiKey ?? process.env.PAGESPEED_API_KEY,
            timeoutMs: opts.pageSpeedTimeoutMs ?? DEFAULT_PSI_TIMEOUT_MS,
          })

    const generator = detectGenerator(html)
    const signals: AuditSignals = {
      finalUrl: finalUrl.toString(),
      https: finalUrl.protocol === 'https:',
      hasViewport: detectViewport(html),
      hasContactForm: detectContactForm(html),
      hasBookingWidget: detectBooking(html),
      copyrightYear: detectCopyrightYear(html),
      generator,
      cmsStatus: detectCmsStatus(html, generator),
      mobileScore,
      truncated,
    }
    const year = (opts.now?.() ?? new Date()).getFullYear()
    return { ok: true, findings: buildFindings(signals, year), signals }
  } catch {
    return { ok: false, error: { kind: 'fetch_failed', message: 'Audit failed unexpectedly' } }
  }
}

/**
 * Fetches one public page through the same SSRF guard as the audit (validated URL, DNS check,
 * manual redirects re-validated, time and size caps). For contact discovery.
 */
export async function fetchPublicPage(
  rawUrl: string,
  opts: Pick<AuditOptions, 'fetch' | 'resolveHost' | 'timeoutMs' | 'maxBytes' | 'maxRedirects'> = {}
): Promise<{ ok: true; html: string; finalUrl: URL } | { ok: false; error: AuditError }> {
  try {
    const v = validateAuditUrl(rawUrl)
    if (!v.ok) return { ok: false, error: v.error }
    const fetched = await fetchHtml(v.url, {
      doFetch: opts.fetch ?? fetch,
      resolve: opts.resolveHost ?? defaultResolve,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
      maxRedirects: opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
    })
    if (!fetched.ok) return { ok: false, error: fetched.error }
    return { ok: true, html: fetched.data.html, finalUrl: fetched.data.finalUrl }
  } catch {
    return { ok: false, error: { kind: 'fetch_failed', message: 'Page could not be fetched' } }
  }
}
