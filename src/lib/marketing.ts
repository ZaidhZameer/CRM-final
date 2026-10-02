// Marketing themes (draft-only marketing agent, step 1): what prospects' research keeps saying
// hurts them, ranked. No AI cost and nothing is published: an agent or a person turns the
// themes into blog or social drafts that still need human approval.

export type Theme = { theme: string; count: number }

const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()

/** Ranks pain points across research reports. Each report counts a theme once. */
export function topThemes(painLists: unknown[], limit = 10): Theme[] {
  const counts = new Map<string, { display: string; n: number }>()
  for (const list of painLists) {
    if (!Array.isArray(list)) continue
    const seen = new Set<string>()
    for (const p of list) {
      const display = String(p ?? '').trim().slice(0, 160)
      const key = clean(display)
      if (key.length < 4 || seen.has(key)) continue
      seen.add(key)
      const cur = counts.get(key)
      if (cur) cur.n++
      else counts.set(key, { display, n: 1 })
    }
  }
  return [...counts.values()].sort((a, b) => b.n - a.n || a.display.localeCompare(b.display)).slice(0, limit).map((v) => ({ theme: v.display, count: v.n }))
}
