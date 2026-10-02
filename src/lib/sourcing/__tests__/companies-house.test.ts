import { describe, expect, it, vi } from 'vitest'
import { getOfficers, searchCompanies } from '../companies-house'
import { createRateLimiter } from '../rate-limiter'

// Hand-written fixtures matching the documented Companies House response shapes.
const SEARCH_FIXTURE = {
  kind: 'search#advanced-search',
  hits: 2,
  items: [
    {
      company_name: 'BRIGHT SMILE DENTAL LTD',
      company_number: '12345678',
      company_status: 'active',
      company_type: 'ltd',
      date_of_creation: '2019-04-02',
      sic_codes: ['86230'],
      registered_office_address: {
        address_line_1: '12 High Street',
        locality: 'Leeds',
        postal_code: 'LS1 4AB',
        country: 'England',
      },
    },
    {
      company_name: 'NORTHERN DENTAL CARE LIMITED',
      company_number: '08765432',
      company_status: 'active',
      date_of_creation: '2016-11-20',
      sic_codes: ['86230', '86900'],
      registered_office_address: { premises: 'Unit 4', address_line_1: 'Mill Lane', postal_code: 'M1 1AA' },
    },
  ],
}

const OFFICERS_FIXTURE = {
  active_count: 2,
  resigned_count: 1,
  items: [
    { name: 'PATEL, Anita Kaur', officer_role: 'director', appointed_on: '2019-04-02' },
    { name: 'JONES, Mark', officer_role: 'director', appointed_on: '2019-04-02', resigned_on: '2022-01-31' },
    { name: 'KHAN, Imran', officer_role: 'secretary', appointed_on: '2020-02-01' },
    { name: 'BROWN, Sarah', officer_role: 'director', appointed_on: '2021-06-15' },
  ],
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })

const noLimit = { acquire: async () => undefined }

function deps(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(fetchImpl)
  const sleep = vi.fn(async () => undefined)
  return { fetchMock, sleep, d: { apiKey: 'test-key', fetch: fetchMock as unknown as typeof fetch, sleep, limiter: noLimit } }
}

describe('searchCompanies', () => {
  it('normalises companies and sends the expected request', async () => {
    const { fetchMock, d } = deps(async () => json(SEARCH_FIXTURE))
    const res = await searchCompanies(
      { sicCodes: ['86230'], location: 'Leeds', incorporatedFrom: '2016-01-01', incorporatedTo: '2024-01-01' },
      d
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data).toEqual([
      {
        company_number: '12345678',
        name: 'BRIGHT SMILE DENTAL LTD',
        sic_codes: ['86230'],
        incorporated_on: '2019-04-02',
        address: '12 High Street, Leeds, LS1 4AB, England',
        directors: [],
      },
      {
        company_number: '08765432',
        name: 'NORTHERN DENTAL CARE LIMITED',
        sic_codes: ['86230', '86900'],
        incorporated_on: '2016-11-20',
        address: 'Unit 4, Mill Lane, M1 1AA',
        directors: [],
      },
    ])
    const [url, init] = fetchMock.mock.calls[0]
    const u = new URL(url)
    expect(u.origin + u.pathname).toBe('https://api.company-information.service.gov.uk/advanced-search/companies')
    expect(u.searchParams.get('sic_codes')).toBe('86230')
    expect(u.searchParams.get('location')).toBe('Leeds')
    expect(u.searchParams.get('incorporated_from')).toBe('2016-01-01')
    expect(u.searchParams.get('company_status')).toBe('active')
    expect(u.searchParams.get('start_index')).toBe('0')
    const auth = (init?.headers as Record<string, string>).Authorization
    expect(Buffer.from(auth.replace('Basic ', ''), 'base64').toString()).toBe('test-key:')
  })

  it('returns an empty list when Companies House omits items', async () => {
    const { d } = deps(async () => json({ kind: 'search#advanced-search', hits: 0 }))
    const res = await searchCompanies({ sicCodes: ['86230'] }, d)
    expect(res).toEqual({ ok: true, data: [] })
  })

  it('paginates up to the cap', async () => {
    const page = (n: number) => ({
      items: Array.from({ length: 2 }, (_, i) => ({
        company_name: `CO ${n}-${i}`,
        company_number: `${n}${i}`,
        sic_codes: ['43210'],
      })),
    })
    const { fetchMock, d } = deps(async (url) => json(page(Number(new URL(url).searchParams.get('start_index')))))
    const res = await searchCompanies({ sicCodes: ['43210'], size: 2, maxResults: 5 }, d)
    expect(res.ok && res.data.length).toBe(5)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(new URL(fetchMock.mock.calls[2][0]).searchParams.get('start_index')).toBe('4')
  })

  it('retries once on 429 then succeeds, honouring Retry-After', async () => {
    let n = 0
    const { fetchMock, sleep, d } = deps(async () =>
      n++ === 0 ? new Response('', { status: 429, headers: { 'retry-after': '3' } }) : json(SEARCH_FIXTURE)
    )
    const res = await searchCompanies({ sicCodes: ['86230'] }, d)
    expect(res.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(3000)
  })

  it('returns rate_limited after a second 429', async () => {
    const { fetchMock, d } = deps(async () => new Response('', { status: 429 }))
    const res = await searchCompanies({ sicCodes: ['86230'] }, d)
    expect(res).toMatchObject({ ok: false, error: { kind: 'rate_limited' } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns bad_response for malformed bodies', async () => {
    const wrongShape = await searchCompanies({ sicCodes: ['1'] }, deps(async () => json({ items: 'nope' })).d)
    expect(wrongShape).toMatchObject({ ok: false, error: { kind: 'bad_response' } })
    const notJson = await searchCompanies({ sicCodes: ['1'] }, deps(async () => new Response('<html>', { status: 200 })).d)
    expect(notJson).toMatchObject({ ok: false, error: { kind: 'bad_response' } })
  })

  it('skips malformed items but keeps good ones', async () => {
    const { d } = deps(async () => json({ items: [null, { company_name: 'NO NUMBER' }, SEARCH_FIXTURE.items[0]] }))
    const res = await searchCompanies({ sicCodes: ['86230'] }, d)
    expect(res.ok && res.data.map((c) => c.company_number)).toEqual(['12345678'])
  })

  it('maps non-429 failures to http_error and network errors without throwing', async () => {
    const http = await searchCompanies({ sicCodes: ['1'] }, deps(async () => new Response('', { status: 401 })).d)
    expect(http).toMatchObject({ ok: false, error: { kind: 'http_error', status: 401 } })
    const net = await searchCompanies(
      { sicCodes: ['1'] },
      deps(async () => {
        throw new Error('boom')
      }).d
    )
    expect(net).toMatchObject({ ok: false, error: { kind: 'http_error', status: 0 } })
  })

  it('returns missing_key without calling the network when no key is set', async () => {
    const prev = process.env.COMPANIES_HOUSE_API_KEY
    delete process.env.COMPANIES_HOUSE_API_KEY
    try {
      const fetchMock = vi.fn()
      const res = await searchCompanies({ sicCodes: ['86230'] }, { fetch: fetchMock as unknown as typeof fetch })
      expect(res).toMatchObject({ ok: false, error: { kind: 'missing_key' } })
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      if (prev !== undefined) process.env.COMPANIES_HOUSE_API_KEY = prev
    }
  })
})

describe('getOfficers', () => {
  it('keeps only active directors and tidies names', async () => {
    const { fetchMock, d } = deps(async () => json(OFFICERS_FIXTURE))
    const res = await getOfficers('12345678', d)
    expect(res).toEqual({
      ok: true,
      data: [
        { name: 'Anita Kaur Patel', role: 'director', appointed_on: '2019-04-02' },
        { name: 'Sarah Brown', role: 'director', appointed_on: '2021-06-15' },
      ],
    })
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.company-information.service.gov.uk/company/12345678/officers')
  })

  it('rejects unsafe company numbers without a request', async () => {
    const { fetchMock, d } = deps(async () => json({}))
    const res = await getOfficers('../admin', d)
    expect(res).toMatchObject({ ok: false, error: { kind: 'bad_response' } })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns bad_response when items is missing', async () => {
    const res = await getOfficers('12345678', deps(async () => json({ active_count: 0 })).d)
    expect(res).toMatchObject({ ok: false, error: { kind: 'bad_response' } })
  })
})

describe('createRateLimiter', () => {
  it('lets max through immediately then waits for the window to slide', async () => {
    let t = 0
    const sleeps: number[] = []
    const limiter = createRateLimiter({
      max: 2,
      windowMs: 1000,
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms)
        t += ms
      },
    })
    await limiter.acquire()
    await limiter.acquire()
    expect(sleeps).toEqual([])
    await limiter.acquire() // must wait for the first stamp (t=0) to expire
    expect(sleeps).toEqual([1000])
    expect(t).toBe(1000)
  })

  it('queues concurrent callers in order', async () => {
    let t = 0
    const order: number[] = []
    const limiter = createRateLimiter({
      max: 1,
      windowMs: 100,
      now: () => t,
      sleep: async (ms) => {
        t += ms
      },
    })
    await Promise.all([1, 2, 3].map((n) => limiter.acquire().then(() => order.push(n))))
    expect(order).toEqual([1, 2, 3])
    expect(t).toBe(200)
  })
})
