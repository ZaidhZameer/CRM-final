import { describe, it, expect } from 'vitest'
import { renderTemplate } from '../auto-reply'

describe('renderTemplate', () => {
  const tpl = 'Hi {first_name}, thanks from {sender_name} re {company}.'
  it('fills first name, company and sender', () => {
    expect(renderTemplate(tpl, { first_name: 'Maya Patel', company: 'Harbor Dental', sender_name: 'Zaid' })).toBe('Hi Maya, thanks from Zaid re Harbor Dental.')
  })
  it('falls back gracefully when values are missing or not a real name', () => {
    expect(renderTemplate(tpl, {})).toBe('Hi there, thanks from The team re your team.')
    expect(renderTemplate(tpl, { first_name: 'E2E Test Contact' })).toMatch(/^Hi there,/)
    expect(renderTemplate(tpl, { first_name: 'test' })).toMatch(/^Hi there,/)
  })
  it('keeps accented names', () => {
    expect(renderTemplate('Hi {first_name}', { first_name: 'Zoë Brontë' })).toBe('Hi Zoë')
  })
})
