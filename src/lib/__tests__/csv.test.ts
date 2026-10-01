import { describe, it, expect } from 'vitest'
import { csvSafe, csvRow } from '../csv'

describe('csvSafe', () => {
  it('neutralises formula-leading characters', () => {
    for (const v of ['=SUM(A1)', '+44 7700 900123', '-1+2', '@cmd', '\tx', '\rx']) {
      expect(csvSafe(v).replace(/^"/, '').startsWith("'")).toBe(true)
    }
  })
  it('leaves ordinary values alone', () => {
    expect(csvSafe('Acme Ltd')).toBe('Acme Ltd')
    expect(csvSafe(42)).toBe('42')
    expect(csvSafe(null)).toBe('')
    expect(csvSafe(undefined)).toBe('')
    expect(csvSafe('a=b')).toBe('a=b')
  })
  it('quotes commas, quotes and newlines', () => {
    expect(csvSafe('a,b')).toBe('"a,b"')
    expect(csvSafe('say "hi"')).toBe('"say ""hi"""')
    expect(csvSafe('l1\nl2')).toBe('"l1\nl2"')
  })
  it('neutralises and quotes together', () => {
    expect(csvSafe('=1,2')).toBe('"\'=1,2"')
  })
})

describe('csvRow', () => {
  it('joins safe cells', () => {
    expect(csvRow(['a', '=x', 'b,c'])).toBe('a,\'=x,"b,c"')
  })
})
