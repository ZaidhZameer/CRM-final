import { describe, expect, it, vi } from 'vitest'
import {
  auditWebsite,
  detectBooking,
  detectCmsStatus,
  detectContactForm,
  detectCopyrightYear,
  detectGenerator,
  detectViewport,
  isPrivateIp,
  validateAuditUrl,
} from '../site-audit'

const NOW = () => new Date('2026-10-02T12:00:00Z')
const publicResolve = async () => ['93.184.216.34']

function page(head: string, body = '') {
  return `<!doctype html><html><head><title>Acme</title>${head}</head><body>${body}</body></html>`
}
const html = (body: string, init: ResponseInit = {}) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init })

const GOOD_PAGE = page(
  '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="generator" content="WordPress 6.5">',
  '<form><input type="email" name="email"><textarea name="message"></textarea></form><footer>&copy; 2026 Acme</footer>'
)

const PSI_FIXTURE = { lighthouseResult: { categories: { performance: { score: 0.42 } } } }

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>
function run(url: string, siteFetch: FetchImpl, psi: FetchImpl | null = null, extra = {}) {
  const fetchMock = vi.fn(async (u: string, init?: RequestInit) => {
    if (u.startsWith('https://www.googleapis.com/pagespeedonline')) {
      if (!psi) throw new Error('psi down')
      return psi(u, init)
    }
    return siteFetch(u, init)
  })
  return {
    fetchMock,
    promise: auditWebsite(url, {
      fetch: fetchMock as unknown as typeof fetch,
      resolveHost: publicResolve,
      now: NOW,
      ...extra,
    }),
  }
}

describe('heuristics', () => {
  it('detects the mobile viewport tag', () => {
    expect(detectViewport(page('<meta name="viewport" content="width=device-width, initial-scale=1">'))).toBe(true)
    expect(detectViewport(page('<meta name="viewport" content="width=1024">'))).toBe(false)
    expect(detectViewport(page(''))).toBe(false)
  })

  it('detects contact forms but not search forms', () => {
    expect(detectContactForm('<form><textarea name="m"></textarea></form>')).toBe(true)
    expect(detectContactForm('<form><input type="email"></form>')).toBe(true)
    expect(detectContactForm('<iframe src="https://form.jotform.com/123"></iframe>')).toBe(true)
    expect(detectContactForm('<form role="search"><input type="search" name="q"></form>')).toBe(false)
    expect(detectContactForm('<p>Call us</p>')).toBe(false)
  })

  it('detects booking widgets and calls to action', () => {
    expect(detectBooking('<script src="https://assets.calendly.com/widget.js"></script>')).toBe(true)
    expect(detectBooking('<a href="/b">Book an appointment</a>')).toBe(true)
    expect(detectBooking('<a href="/b">Book Online</a>')).toBe(true)
    expect(detectBooking('<p>We have a book club</p>')).toBe(false)
  })

  it('takes the latest copyright year, including ranges and entities', () => {
    expect(detectCopyrightYear('<footer>&copy; 2017 Acme</footer>')).toBe(2017)
    expect(detectCopyrightYear('Copyright 2012-2018 Acme')).toBe(2018)
    expect(detectCopyrightYear('© 2015 Old   &copy; 2019 New')).toBe(2019)
    expect(detectCopyrightYear('<p>Established 1998</p>')).toBeNull()
  })

  it('classifies generators and platform fingerprints', () => {
    expect(detectGenerator('<meta name="generator" content="WordPress 4.9.8" />')).toBe('WordPress 4.9.8')
    expect(detectGenerator(page(''))).toBeNull()
    expect(detectCmsStatus('', 'WordPress 4.9.8')).toBe('outdated')
    expect(detectCmsStatus('', 'WordPress 6.5')).toBe('current')
    expect(detectCmsStatus('', 'Joomla! 3.9')).toBe('outdated')
    expect(detectCmsStatus('', 'Microsoft FrontPage 4.0')).toBe('outdated')
    expect(detectCmsStatus('<link href="/wp-content/x.css">', null)).toBe('current')
    expect(detectCmsStatus('<p>hand rolled</p>', null)).toBe('none_detected')
  })
})

describe('validateAuditUrl / SSRF', () => {
  it.each([
    'http://localhost',
    'http://localhost:3000/admin',
    'http://foo.localhost',
    'http://127.0.0.1',
    'http://127.0.0.1:80/',
    'http://10.0.0.5/',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://[::ffff:7f00:1]/',
    'http://[fe80::1]/',
    'http://[fd00::1]/',
    'http://2130706433/', // decimal form of 127.0.0.1
    'http://0x7f.0.0.1/',
    'http://intranet/',
    'http://printer.local/',
    'http://user:pass@example.com/',
    'http://example.com:8080/',
    'file:///etc/passwd',
    'ftp://example.com/',
    'javascript:alert(1)',
    '',
  ])('rejects %s', (u) => {
    expect(validateAuditUrl(u).ok).toBe(false)
  })

  it('accepts public URLs and defaults bare domains to https', () => {
    const a = validateAuditUrl('example.co.uk')
    expect(a.ok && a.url.toString()).toBe('https://example.co.uk/')
    expect(validateAuditUrl('http://example.com/page').ok).toBe(true)
    expect(validateAuditUrl('https://93.184.216.34/').ok).toBe(true)
  })

  it('classifies private IP literals', () => {
    expect(isPrivateIp('100.64.0.1')).toBe(true)
    expect(isPrivateIp('172.32.0.1')).toBe(false)
    expect(isPrivateIp('8.8.8.8')).toBe(false)
    expect(isPrivateIp('2606:4700:4700::1111')).toBe(false)
  })

  it('never fetches blocked URLs', async () => {
    const { fetchMock, promise } = run('http://169.254.169.254/latest/meta-data/', async () => html(''))
    expect(await promise).toMatchObject({ ok: false, error: { kind: 'blocked_host' } })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('blocks hostnames that resolve to private addresses', async () => {
    const fetchMock = vi.fn()
    const res = await auditWebsite('https://evil.example.com', {
      fetch: fetchMock as unknown as typeof fetch,
      resolveHost: async () => ['93.184.216.34', '10.0.0.7'],
    })
    expect(res).toMatchObject({ ok: false, error: { kind: 'blocked_host' } })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('blocks redirects into private ranges', async () => {
    const { promise } = run('https://example.com', async () =>
      new Response('', { status: 302, headers: { location: 'http://169.254.169.254/' } })
    )
    expect(await promise).toMatchObject({ ok: false, error: { kind: 'blocked_host' } })
  })

  it('follows a safe redirect and reports the final URL', async () => {
    let n = 0
    const { promise } = run('http://example.com', async () =>
      n++ === 0 ? new Response('', { status: 301, headers: { location: 'https://www.example.com/' } }) : html(GOOD_PAGE)
    , null)
    const res = await promise
    expect(res.ok && res.signals.finalUrl).toBe('https://www.example.com/')
    expect(res.ok && res.signals.https).toBe(true)
  })
})

describe('auditWebsite', () => {
  it('sends the FlowLead user agent and returns no findings for a healthy site', async () => {
    const { fetchMock, promise } = run('https://example.com', async () => html(GOOD_PAGE), async () =>
      new Response(JSON.stringify({ lighthouseResult: { categories: { performance: { score: 0.93 } } } }))
    )
    const res = await promise
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.findings).toEqual([])
    expect(res.signals).toMatchObject({ https: true, hasViewport: true, hasContactForm: true, mobileScore: 93, cmsStatus: 'current' })
    const siteCall = fetchMock.mock.calls.find((c) => c[0] === 'https://example.com/')
    expect((siteCall?.[1]?.headers as Record<string, string>)['User-Agent']).toContain('FlowLead')
  })

  it('ranks findings by severity and returns at most 3', async () => {
    const bad = page(
      '<meta name="generator" content="WordPress 4.9.8">',
      '<footer>&copy; 2016 Acme</footer>'
    )
    const { promise } = run('http://example.com', async () => html(bad), async () => new Response(JSON.stringify(PSI_FIXTURE)))
    const res = await promise
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.findings).toHaveLength(3)
    expect(res.findings.map((f) => f.severity)).toEqual(['high', 'high', 'high'])
    expect(res.findings.map((f) => f.code)).toEqual(['no_https', 'not_mobile_friendly', 'slow_on_mobile'])
    expect(res.findings[1].message).toBe(
      "Your site isn't mobile-friendly, so most visitors on phones see a shrunken desktop page."
    )
    expect(res.findings[2].message).toContain('42/100')
  })

  it('flags no contact route, outdated platform and stale copyright', async () => {
    const bad = page(
      '<meta name="viewport" content="width=device-width"><meta name="generator" content="WordPress 4.9.8">',
      '<footer>&copy; 2020 Acme</footer>'
    )
    const { promise } = run('https://example.com', async () => html(bad))
    const res = await promise
    expect(res.ok && res.findings.map((f) => f.code)).toEqual(['no_easy_contact', 'outdated_platform', 'stale_copyright'])
  })

  it('treats copyright as stale only when older than current year minus 2', async () => {
    const mk = (y: number) =>
      run('https://example.com', async () => html(page('<meta name="viewport" content="width=device-width"><meta name="generator" content="WordPress 6.5">', `<form><textarea></textarea></form>&copy; ${y}`)))
        .promise
    expect((await mk(2024)).ok && (await mk(2024) as { findings: unknown[] }).findings).toEqual([])
    const stale = await mk(2023)
    expect(stale.ok && stale.findings.map((f) => f.code)).toEqual(['stale_copyright'])
  })

  it('omits the PageSpeed score when the API fails or returns junk', async () => {
    const failing = await run('https://example.com', async () => html(GOOD_PAGE), null).promise
    expect(failing.ok && failing.signals.mobileScore).toBeNull()
    expect(failing.ok && failing.findings).toEqual([])

    const non200 = await run('https://example.com', async () => html(GOOD_PAGE), async () => new Response('', { status: 500 })).promise
    expect(non200.ok && non200.signals.mobileScore).toBeNull()

    const junk = await run('https://example.com', async () => html(GOOD_PAGE), async () => new Response('{"x":1}')).promise
    expect(junk.ok && junk.signals.mobileScore).toBeNull()
  })

  it('skips PageSpeed when disabled and passes the key without exposing it elsewhere', async () => {
    const off = run('https://example.com', async () => html(GOOD_PAGE), null, { usePageSpeed: false })
    await off.promise
    expect(off.fetchMock).toHaveBeenCalledTimes(1)

    const on = run('https://example.com', async () => html(GOOD_PAGE), async () => new Response(JSON.stringify(PSI_FIXTURE)), {
      pageSpeedApiKey: 'psi-key',
    })
    await on.promise
    const psiUrl = new URL(on.fetchMock.mock.calls.find((c) => c[0].includes('pagespeedonline'))![0])
    expect(psiUrl.searchParams.get('strategy')).toBe('mobile')
    expect(psiUrl.searchParams.get('url')).toBe('https://example.com/')
    expect(psiUrl.searchParams.get('key')).toBe('psi-key')
  })

  it('times out slow sites', async () => {
    const { promise } = run(
      'https://example.com',
      (_u, init) =>
        new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
        }),
      null,
      { timeoutMs: 20 }
    )
    expect(await promise).toMatchObject({ ok: false, error: { kind: 'timeout' } })
  })

  it('caps the body size and stops reading', async () => {
    let pulled = 0
    const chunk = new TextEncoder().encode('x'.repeat(1024))
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(chunk)
      },
    })
    const { promise } = run('https://example.com', async () => new Response(stream, { headers: { 'content-type': 'text/html' } }), null, {
      maxBytes: 4096,
      usePageSpeed: false,
    })
    const res = await promise
    expect(res.ok && res.signals.truncated).toBe(true)
    expect(pulled).toBeLessThan(20) // would be unbounded without the cap
  })

  it('returns typed errors for HTTP failures and non-HTML content', async () => {
    const nf = await run('https://example.com', async () => new Response('', { status: 404 })).promise
    expect(nf).toMatchObject({ ok: false, error: { kind: 'http_error', status: 404 } })
    const pdf = await run('https://example.com', async () => new Response('%PDF', { headers: { 'content-type': 'application/pdf' } })).promise
    expect(pdf).toMatchObject({ ok: false, error: { kind: 'not_html' } })
  })
})
