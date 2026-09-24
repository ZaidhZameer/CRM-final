import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { z } from 'zod/v4'
import { CONTRACTS } from '../automation/contract'

// n8n validates against docs/contracts/*.schema.json. If a Zod contract changes without
// regenerating those files, the two sides disagree — the exact bug class this guards.
describe('contract files match the Zod contracts', () => {
  for (const [type, schema] of Object.entries(CONTRACTS)) {
    it(`${type}.schema.json is up to date (run pnpm contracts:export)`, () => {
      const onDisk = JSON.parse(readFileSync(`docs/contracts/${type}.schema.json`, 'utf8'))
      expect(onDisk).toEqual(z.toJSONSchema(schema, { io: 'input' }))
    })
  }
})
