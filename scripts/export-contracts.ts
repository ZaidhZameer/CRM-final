// Writes docs/contracts/<event_type>.schema.json from src/lib/automation/contract.ts.
// n8n validates outgoing messages against the same shapes. Run: pnpm contracts:export
import { writeFileSync } from 'node:fs'
import { z } from 'zod/v4'
import { CONTRACTS } from '../src/lib/automation/contract.ts'

for (const [type, schema] of Object.entries(CONTRACTS)) {
  const json = JSON.stringify(z.toJSONSchema(schema, { io: 'input' }), null, 2) + '\n'
  writeFileSync(`docs/contracts/${type}.schema.json`, json)
  console.log(`wrote docs/contracts/${type}.schema.json`)
}
