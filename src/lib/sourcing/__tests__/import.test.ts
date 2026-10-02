import { describe, it, expect } from 'vitest'
import { cleanWebsite, importSourceLabel } from '../import'

describe('importSourceLabel', () => {
  it('always namespaces, so an importer can never claim web_form or booking_page', () => {
    expect(importSourceLabel('web_form')).toBe('import_web_form')
    expect(importSourceLabel('booking_page')).toBe('import_booking_page')
    expect(importSourceLabel('CQC Register!')).toBe('import_cqc_register')
  })
  it('rejects empty or one-character names', () => {
    expect(importSourceLabel('  ')).toBeNull()
    expect(importSourceLabel('a')).toBeNull()
  })
})

describe('cleanWebsite', () => {
  it('keeps only the origin and lowercases the host', () => {
    expect(cleanWebsite('HarborDental.co.uk/contact?x=1')).toBe('https://harbordental.co.uk')
    expect(cleanWebsite('http://Example.com:8080/a')).toBe('http://example.com')
  })
  it('drops non-web schemes and junk', () => {
    expect(cleanWebsite('javascript:alert(1)')).toBeNull()
    expect(cleanWebsite('ftp://x.com')).toBeNull()
    expect(cleanWebsite('')).toBeNull()
    expect(cleanWebsite(null)).toBeNull()
  })
})
