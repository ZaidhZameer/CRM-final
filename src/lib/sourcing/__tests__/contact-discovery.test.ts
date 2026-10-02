import { describe, it, expect } from 'vitest'
import { discoverContact, extractPublishedEmails, findContactPageUrl, pickContactEmail, siteMatchesCompany } from '../contact-discovery'

const resolveHost = async () => ['93.184.216.34']
const page = (body: string, status = 200) => new Response(`<html><body>${body}</body></html>`, { status, headers: { 'content-type': 'text/html' } })
const fakeFetch = (pages: Record<string, string>) => (async (url: string | URL) => {
  const u = String(url)
  return u in pages ? page(pages[u]) : new Response('nope', { status: 404 })
}) as unknown as typeof fetch

describe('extractPublishedEmails', () => {
  const host = 'www.harbordental.co.uk'
  it('reads mailto links and printed addresses on the company domain', () => {
    const html = '<a href="mailto:Info@HarborDental.co.uk">Email us</a> or sales@harbordental.co.uk'
    expect(extractPublishedEmails(html, host).map((e) => e.email).sort()).toEqual(['info@harbordental.co.uk', 'sales@harbordental.co.uk'])
  })
  it('decodes entity-obfuscated addresses', () => {
    expect(extractPublishedEmails('hello&#64;harbordental.co.uk', host)[0]?.email).toBe('hello@harbordental.co.uk')
  })
  it('ignores addresses on other domains, junk and file names', () => {
    const html = 'partner@other-company.com logo@2x.png someone@example.com a@sentry.io'
    expect(extractPublishedEmails(html, host)).toEqual([])
  })
  it('ignores addresses inside scripts and styles', () => {
    expect(extractPublishedEmails('<script>var e="info@harbordental.co.uk"</script>', host)).toEqual([])
  })
})

describe('pickContactEmail', () => {
  it('prefers role addresses by rank and refuses personal addresses by default', () => {
    const emails = extractPublishedEmails('maya.patel@acme.co.uk reception@acme.co.uk info@acme.co.uk', 'acme.co.uk')
    expect(pickContactEmail(emails)?.email).toBe('info@acme.co.uk')
    expect(pickContactEmail(extractPublishedEmails('maya.patel@acme.co.uk', 'acme.co.uk'))).toBeNull()
    expect(pickContactEmail(extractPublishedEmails('maya.patel@acme.co.uk', 'acme.co.uk'), true)?.email).toBe('maya.patel@acme.co.uk')
  })
})

describe('findContactPageUrl / siteMatchesCompany', () => {
  it('finds a same-origin contact link and ignores other origins', () => {
    const base = new URL('https://acme.co.uk/')
    expect(findContactPageUrl('<a href="/contact-us">Contact</a>', base)).toBe('https://acme.co.uk/contact-us')
    expect(findContactPageUrl('<a href="https://evil.test/contact">x</a>', base)).toBeNull()
  })
  it('requires the page to mention the company (or its number)', () => {
    expect(siteMatchesCompany('<h1>Harbor Dental Studio</h1>', 'HARBOR DENTAL STUDIO LTD')).toBe(true)
    expect(siteMatchesCompany('<h1>Totally Different Plumbing</h1>', 'HARBOR DENTAL STUDIO LTD')).toBe(false)
    expect(siteMatchesCompany('Company no. 01234567', 'X Y Z LTD', '01234567')).toBe(true)
  })
})

describe('discoverContact', () => {
  it('verifies the site, follows the contact page and returns a published role address', async () => {
    const fetch = fakeFetch({
      'https://harbordental.co.uk/': '<h1>Harbor Dental Studio</h1><a href="/contact">Contact</a>',
      'https://harbordental.co.uk/contact': 'Write to <a href="mailto:hello@harbordental.co.uk">hello@harbordental.co.uk</a>',
    })
    const r = await discoverContact('harbordental.co.uk', { name: 'HARBOR DENTAL STUDIO LTD' }, { fetch, resolveHost })
    expect(r).toMatchObject({ ok: true, website: 'https://harbordental.co.uk', email: { email: 'hello@harbordental.co.uk', isRole: true } })
  })
  it('rejects a website that is not this company', async () => {
    const fetch = fakeFetch({ 'https://wrong.example/': '<h1>Another business</h1> info@wrong.example' })
    expect(await discoverContact('wrong.example', { name: 'HARBOR DENTAL STUDIO LTD' }, { fetch, resolveHost })).toEqual({ ok: false, reason: 'not_this_company' })
  })
  it('never reaches internal addresses, and handles unreachable sites', async () => {
    expect(await discoverContact('http://127.0.0.1/', { name: 'X Ltd' })).toEqual({ ok: false, reason: 'blocked' })
    expect(await discoverContact('nothere.test', { name: 'X Ltd' }, { fetch: fakeFetch({}), resolveHost })).toEqual({ ok: false, reason: 'unreachable' })
  })
  it('returns the verified site with no email when none is published', async () => {
    const fetch = fakeFetch({ 'https://quiet.co.uk/': '<h1>Quiet Dental</h1> Call us today' })
    expect(await discoverContact('quiet.co.uk', { name: 'QUIET DENTAL LTD' }, { fetch, resolveHost })).toEqual({ ok: true, website: 'https://quiet.co.uk', email: null, sourceUrl: null })
  })
})
