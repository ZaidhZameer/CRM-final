import { describe, it, expect } from 'vitest'
import { classifyReply, replyEventId } from '../reply-watcher'

describe('classifyReply', () => {
  it('spots opt-outs', () => {
    expect(classifyReply({ snippet: 'Please stop emailing me.' })).toBe('unsubscribe')
    expect(classifyReply({ snippet: 'Unsubscribe' })).toBe('unsubscribe')
    expect(classifyReply({ snippet: "Remove me from your list thanks" })).toBe('unsubscribe')
  })
  it('spots auto-replies by header or subject', () => {
    expect(classifyReply({ autoSubmitted: 'auto-replied', snippet: 'Thanks for your email' })).toBe('out_of_office')
    expect(classifyReply({ subject: 'Automatic reply: Quick idea', snippet: 'I am away until Monday' })).toBe('out_of_office')
    expect(classifyReply({ subject: 'Out of Office', snippet: '' })).toBe('out_of_office')
  })
  it('treats a normal reply as one for a human, even when it quotes our opt-out line', () => {
    const quoted = "Sounds good, can we talk Thursday? On Tue, 29 Sep 2026 at 09:30, Zaid wrote: ... just reply 'stop' and I won't email again."
    expect(classifyReply({ snippet: quoted })).toBe('other')
    expect(classifyReply({ snippet: 'Not right now, maybe next quarter' })).toBe('other')
  })
  it('an explicit Auto-Submitted: no is a human reply', () => {
    expect(classifyReply({ autoSubmitted: 'no', snippet: 'Yes please' })).toBe('other')
  })
})

describe('replyEventId', () => {
  it('is stable per message and a valid UUID', () => {
    const a = replyEventId('org-1', 'gm-123')
    expect(a).toBe(replyEventId('org-1', 'gm-123'))
    expect(a).not.toBe(replyEventId('org-1', 'gm-124'))
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
