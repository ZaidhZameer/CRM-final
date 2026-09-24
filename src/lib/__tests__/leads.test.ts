import { describe, it, expect } from 'vitest'
import { websiteFromEmail } from '../leads'

describe('websiteFromEmail', () => {
  it('derives a site from a business email', () => {
    expect(websiteFromEmail('Maya@HarborDental.co.uk')).toBe('https://harbordental.co.uk')
  })
  it('ignores free mailboxes', () => {
    expect(websiteFromEmail('someone@gmail.com')).toBeNull()
    expect(websiteFromEmail('someone@hotmail.co.uk')).toBeNull()
  })
  it('ignores reserved test domains', () => {
    expect(websiteFromEmail('x@example.com')).toBeNull()
    expect(websiteFromEmail('x@shop.test')).toBeNull()
  })
  it('handles missing or malformed input', () => {
    expect(websiteFromEmail(null)).toBeNull()
    expect(websiteFromEmail('not-an-email')).toBeNull()
    expect(websiteFromEmail('a@nodot')).toBeNull()
  })
})
