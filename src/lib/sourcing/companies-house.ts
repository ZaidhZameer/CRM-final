import { createRateLimiter, type RateLimiter } from './rate-limiter'
import { defaultSleep, fail, ok, type SleepFn, type SourcingResult } from './types'

const BASE_URL = 'https://api.company-information.service.gov.uk'
const MAX_RETRY_WAIT_MS = 30_000
const DEFAULT_BACKOFF_MS = 2_000

export type Director = { name: string; role: string; appointed_on: string | null }

export type SourcedCompany = {
  company_number: string
  name: string
  sic_codes: string[]
  incorporated_on: string | null
  /** Registered office, joined into one comma-separated line. */
  address: string
  directors: Director[]
}

export type SearchCompaniesParams = {
  sicCodes: string[]
  /** Town or postcode area, passed to Companies House `location`. */
  location?: string
  /** ISO dates (YYYY-MM-DD). */
  incorporatedFrom?: string
  incorporatedTo?: string
  /** Page size per request (1-5000, default 100). */
  size?: number
  /** Hard cap on companies returned across pages (default 200). */
  maxResults?: number
}

export type CompaniesHouseDeps = {
  /** Defaults to process.env.COMPANIES_HOUSE_API_KEY. Never logged. */
  apiKey?: string
  fetch?: typeof fetch
  sleep?: SleepFn
  limiter?: RateLimiter
}

// Shared across calls in this process: 600 requests / 5 min per key, with a small safety margin.
const sharedLimiter = createRateLimiter({ max: 580, windowMs: 5 * 60_000 })

function basicAuth(key: string): string {
  return 'Basic ' + Buffer.from(`${key}:`).toString('base64')
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** GET with auth, rate limiting and one retry on 429. Returns parsed JSON. */
async function chGet(
  path: string,
  query: URLSearchParams | null,
  deps: CompaniesHouseDeps
): Promise<SourcingResult<unknown>> {
  const apiKey = deps.apiKey ?? process.env.COMPANIES_HOUSE_API_KEY
  if (!apiKey) {
    return fail({ kind: 'missing_key', message: 'COMPANIES_HOUSE_API_KEY is not set' })
  }
  const doFetch = deps.fetch ?? fetch
  const sleep = deps.sleep ?? defaultSleep
  const limiter = deps.limiter ?? sharedLimiter
  const url = `${BASE_URL}${path}${query ? `?${query.toString()}` : ''}`

  for (let attempt = 0; attempt < 2; attempt++) {
    await limiter.acquire()
    let res: Response
    try {
      res = await doFetch(url, {
        headers: { Authorization: basicAuth(apiKey), Accept: 'application/json' },
      })
    } catch {
      return fail({ kind: 'http_error', status: 0, message: 'Network error calling Companies House' })
    }

    if (res.status === 429) {
      const header = Number(res.headers.get('retry-after'))
      const waitMs =
        Number.isFinite(header) && header > 0
          ? Math.min(header * 1000, MAX_RETRY_WAIT_MS)
          : DEFAULT_BACKOFF_MS
      if (attempt === 0) {
        await sleep(waitMs)
        continue
      }
      return fail({ kind: 'rate_limited', retryAfterMs: waitMs, message: 'Companies House rate limit hit' })
    }
    if (!res.ok) {
      return fail({ kind: 'http_error', status: res.status, message: `Companies House returned HTTP ${res.status}` })
    }
    try {
      return ok(await res.json())
    } catch {
      return fail({ kind: 'bad_response', message: 'Companies House response was not valid JSON' })
    }
  }
  return fail({ kind: 'rate_limited', message: 'Companies House rate limit hit' })
}

function joinAddress(a: unknown): string {
  if (!isObject(a)) return ''
  return [a.care_of, a.premises, a.address_line_1, a.address_line_2, a.locality, a.region, a.postal_code, a.country]
    .map(str)
    .filter((p): p is string => p !== null)
    .join(', ')
}

function normaliseCompany(item: unknown): SourcedCompany | null {
  if (!isObject(item)) return null
  const number = str(item.company_number)
  const name = str(item.company_name)
  if (!number || !name) return null
  return {
    company_number: number,
    name,
    sic_codes: Array.isArray(item.sic_codes) ? item.sic_codes.map(str).filter((s): s is string => s !== null) : [],
    incorporated_on: str(item.date_of_creation),
    address: joinAddress(item.registered_office_address),
    directors: [],
  }
}

/** Advanced Company Search: active companies matching SIC codes / location / incorporation window. */
export async function searchCompanies(
  params: SearchCompaniesParams,
  deps: CompaniesHouseDeps = {}
): Promise<SourcingResult<SourcedCompany[]>> {
  const size = Math.min(Math.max(params.size ?? 100, 1), 5000)
  const cap = Math.max(params.maxResults ?? 200, 1)
  const out: SourcedCompany[] = []

  for (let start = 0; out.length < cap; start += size) {
    const q = new URLSearchParams()
    if (params.sicCodes.length) q.set('sic_codes', params.sicCodes.join(','))
    if (params.location) q.set('location', params.location)
    if (params.incorporatedFrom) q.set('incorporated_from', params.incorporatedFrom)
    if (params.incorporatedTo) q.set('incorporated_to', params.incorporatedTo)
    q.set('company_status', 'active')
    q.set('size', String(size))
    q.set('start_index', String(start))

    const res = await chGet('/advanced-search/companies', q, deps)
    if (!res.ok) return res
    const body = res.data
    // An empty result set omits `items` entirely; anything non-object is malformed.
    if (!isObject(body) || (body.items !== undefined && !Array.isArray(body.items))) {
      return fail({ kind: 'bad_response', message: 'Unexpected advanced-search response shape' })
    }
    const items = (body.items as unknown[] | undefined) ?? []
    for (const it of items) {
      const c = normaliseCompany(it)
      if (c) out.push(c)
    }
    if (items.length < size) break
  }
  return ok(out.slice(0, cap))
}

/** "SMITH, John Paul" -> "John Paul Smith". Leaves other shapes (e.g. corporate names) alone. */
function tidyName(raw: string): string {
  const i = raw.indexOf(',')
  if (i === -1) return raw
  const surname = raw.slice(0, i).trim()
  const rest = raw.slice(i + 1).trim()
  const cap = (s: string) => s.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_m, p, c: string) => p + c.toUpperCase())
  return `${cap(rest)} ${cap(surname)}`.trim()
}

/** Active directors only: resigned officers and non-director roles (secretaries etc.) are dropped. */
export async function getOfficers(
  companyNumber: string,
  deps: CompaniesHouseDeps = {}
): Promise<SourcingResult<Director[]>> {
  const number = companyNumber.trim()
  if (!/^[A-Za-z0-9]{1,12}$/.test(number)) {
    return fail({ kind: 'bad_response', message: 'Invalid company number' })
  }
  const res = await chGet(`/company/${number}/officers`, null, deps)
  if (!res.ok) return res
  const body = res.data
  if (!isObject(body) || !Array.isArray(body.items)) {
    return fail({ kind: 'bad_response', message: 'Unexpected officers response shape' })
  }
  const directors: Director[] = []
  for (const o of body.items) {
    if (!isObject(o)) continue
    const name = str(o.name)
    const role = str(o.officer_role)
    if (!name || !role || !role.includes('director')) continue
    if (str(o.resigned_on)) continue
    directors.push({ name: tidyName(name), role, appointed_on: str(o.appointed_on) })
  }
  return ok(directors)
}
