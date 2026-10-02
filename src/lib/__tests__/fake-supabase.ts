import type { SupabaseClient } from '@supabase/supabase-js'

// A tiny in-memory stand-in for the Supabase query builder, enough for handler logic tests.
// Supports select / insert / update / delete with eq, neq, is, in, gte, lt, ilike-free filters,
// order, limit, single and maybeSingle. Embedded selects (`contacts(...)`) are ignored: put the
// joined objects straight into the row. Insert errors can be injected per table.

type Row = Record<string, unknown>
export type FakeDb = Record<string, Row[]>
type Filter = (r: Row) => boolean

let seq = 0

export function fakeSupabase(db: FakeDb, opts: { insertError?: Record<string, { code?: string; message: string }> } = {}) {
  const calls: { table: string; op: string; payload?: unknown }[] = []

  function from(table: string) {
    db[table] ??= []
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select'
    let patch: Row | Row[] | null = null
    const filters: Filter[] = []
    let limitN = Infinity
    let order: { col: string; asc: boolean } | null = null
    let wantCount = false
    let headOnly = false

    const matches = () => db[table].filter((r) => filters.every((f) => f(r)))

    const run = (): { data: unknown; error: { code?: string; message: string } | null; count?: number } => {
      calls.push({ table, op, payload: patch ?? undefined })
      if (op === 'insert') {
        const err = opts.insertError?.[table]
        if (err) return { data: null, error: err }
        const rows = (Array.isArray(patch) ? patch : [patch!]).map((p) => ({ id: `fake-${++seq}`, created_at: new Date().toISOString(), ...p }))
        db[table].push(...rows)
        return { data: rows, error: null }
      }
      if (op === 'update') {
        const rows = matches()
        rows.forEach((r) => Object.assign(r, patch))
        return { data: rows, error: null }
      }
      if (op === 'delete') {
        const rows = matches()
        db[table] = db[table].filter((r) => !rows.includes(r))
        return { data: rows, error: null }
      }
      let rows = matches()
      const total = rows.length
      if (order) {
        const { col, asc } = order
        rows = [...rows].sort((a, b) => (String(a[col] ?? '') < String(b[col] ?? '') ? -1 : 1) * (asc ? 1 : -1))
      }
      rows = rows.slice(0, limitN)
      return { data: headOnly ? null : rows, error: null, count: wantCount ? total : undefined }
    }

    const b: Record<string, unknown> = {}
    const chain = (fn: (...a: never[]) => void) => (...a: never[]) => { fn(...a); return b }
    b.select = chain(((_cols?: string, o?: { count?: string; head?: boolean }) => { wantCount = !!o?.count; headOnly = !!o?.head }) as never)
    b.insert = chain(((p: Row | Row[]) => { op = 'insert'; patch = p }) as never)
    b.update = chain(((p: Row) => { op = 'update'; patch = p }) as never)
    b.delete = chain((() => { op = 'delete' }) as never)
    b.eq = chain(((c: string, v: unknown) => { filters.push((r) => r[c] === v) }) as never)
    b.neq = chain(((c: string, v: unknown) => { filters.push((r) => r[c] !== v) }) as never)
    b.is = chain(((c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v) }) as never)
    b.in = chain(((c: string, v: unknown[]) => { filters.push((r) => v.includes(r[c])) }) as never)
    b.gte = chain(((c: string, v: string) => { filters.push((r) => String(r[c]) >= v) }) as never)
    b.lt = chain(((c: string, v: string) => { filters.push((r) => String(r[c]) < v) }) as never)
    b.or = chain((() => {}) as never)
    b.order = chain(((c: string, o?: { ascending?: boolean }) => { order = { col: c, asc: o?.ascending !== false } }) as never)
    b.limit = chain(((n: number) => { limitN = n }) as never)
    b.single = () => {
      const r = run()
      const first = Array.isArray(r.data) ? r.data[0] : null
      return Promise.resolve(first ? { data: first, error: r.error } : { data: null, error: r.error ?? { message: 'no rows' } })
    }
    b.maybeSingle = () => {
      const r = run()
      return Promise.resolve({ data: (Array.isArray(r.data) ? r.data[0] : null) ?? null, error: r.error })
    }
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject)
    return b
  }

  return { client: { from } as unknown as SupabaseClient, calls, db }
}
