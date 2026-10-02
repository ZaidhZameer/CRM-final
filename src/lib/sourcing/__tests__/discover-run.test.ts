import { describe, it, expect, vi } from 'vitest'
import { runContactDiscovery } from '../discover-run'

type Rows = Record<string, unknown[]>
function fakeService(rows: Rows) {
  const updates: unknown[] = []; const notes: unknown[] = []
  const chain = (table: string) => {
    const q: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'is', 'or', 'not', 'order', 'limit']) q[m] = () => q
    q.then = (res: (v: unknown) => unknown) => res({ data: rows[table] ?? [], error: null })
    q.update = (v: unknown) => { updates.push(v); const u: Record<string, unknown> = {}; for (const m of ['eq', 'is']) u[m] = () => u; u.then = (res: (v: unknown) => unknown) => res({ error: null }); return u }
    q.insert = (v: unknown) => { notes.push(v); return Promise.resolve({ error: null }) }
    return q
  }
  return { service: { from: chain } as never, updates, notes }
}
const lead = { id: 'l1', contact_id: 'c1', companies: { name: 'Harbor Dental', website: 'harbordental.co.uk' }, contacts: { email: null } }

describe('runContactDiscovery', () => {
  it('fills a published role address and notes it, when the agent is on', async () => {
    const f = fakeService({ agent_controls: [], agent_settings: [{ organization_id: 'o1', autonomy_level: 1 }], leads: [lead] })
    const discover = vi.fn(async () => ({ ok: true as const, website: 'https://harbordental.co.uk', email: { email: 'info@harbordental.co.uk', isRole: true }, sourceUrl: 'https://harbordental.co.uk/' }))
    const out = await runContactDiscovery(f.service, { discover })
    expect(out.o1).toEqual({ checked: 1, filled: 1 })
    expect(f.updates).toEqual([{ email: 'info@harbordental.co.uk' }])
    expect(f.notes).toHaveLength(1)
  })
  it('does nothing when the agent is off or the org is paused', async () => {
    const discover = vi.fn()
    const off = fakeService({ agent_controls: [], agent_settings: [{ organization_id: 'o1', autonomy_level: 0 }], leads: [lead] })
    const paused = fakeService({ agent_controls: [{ organization_id: 'o1' }], agent_settings: [{ organization_id: 'o1', autonomy_level: 2 }], leads: [lead] })
    expect(await runContactDiscovery(off.service, { discover })).toEqual({})
    expect(await runContactDiscovery(paused.service, { discover })).toEqual({})
    expect(discover).not.toHaveBeenCalled()
  })
  it('skips leads that already have an email or no website', async () => {
    const f = fakeService({ agent_controls: [], agent_settings: [{ organization_id: 'o1', autonomy_level: 1 }], leads: [{ ...lead, contacts: { email: 'a@b.co' } }, { ...lead, companies: { name: 'X', website: null } }] })
    const discover = vi.fn()
    expect((await runContactDiscovery(f.service, { discover })).o1).toEqual({ checked: 0, filled: 0 })
    expect(discover).not.toHaveBeenCalled()
  })
})
