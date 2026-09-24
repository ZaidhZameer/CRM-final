import { describe, it, expect } from 'vitest'
import { buildRawEmail } from '../gmail'

const decode = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8')
const bodyOf = (msg: string) => Buffer.from(msg.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8')

describe('buildRawEmail', () => {
  const base = { from: 'Zaid <zaid@webvoxel.co.uk>', to: 'maya@harbordental.co.uk', subject: 'Quick question', body: 'Hi Maya,\nOne idea.\n' }

  it('builds a plain-text message with no HTML (so no tracking pixel is possible)', () => {
    const msg = decode(buildRawEmail(base))
    expect(msg).toContain('Content-Type: text/plain; charset="UTF-8"')
    expect(msg).not.toMatch(/text\/html/i)
    expect(bodyOf(msg)).toBe('Hi Maya,\r\nOne idea.\r\n')
  })

  it('blocks header injection through the subject or recipient', () => {
    const msg = decode(buildRawEmail({ ...base, subject: 'Hi\r\nBcc: attacker@evil.test', to: 'a@b.co\nCc: x@y.z' }))
    const headers = msg.split('\r\n\r\n')[0]
    expect(headers).not.toMatch(/^Bcc:/m)
    expect(headers).not.toMatch(/^Cc:/m)
  })

  it('encodes non-ASCII subjects (RFC 2047)', () => {
    const msg = decode(buildRawEmail({ ...base, subject: 'Café idea ☕' }))
    expect(msg).toMatch(/^Subject: =\?UTF-8\?B\?/m)
  })

  it('threads replies with In-Reply-To and References', () => {
    const msg = decode(buildRawEmail({ ...base, inReplyTo: '<abc@mail.gmail.com>' }))
    expect(msg).toContain('In-Reply-To: <abc@mail.gmail.com>')
    expect(msg).toContain('References: <abc@mail.gmail.com>')
  })
})
