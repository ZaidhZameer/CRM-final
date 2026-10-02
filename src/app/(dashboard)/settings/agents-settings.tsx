'use client'

import { useEffect, useState } from 'react'
import { Bot } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AGENTS, AGENT_KEYS, type AgentKey } from '@/lib/agents'
import { getAgentsCard, setAgentLevel, setAgentsPaused, type AgentsCard } from './agents-actions'

const LEVEL_LABEL = ['Off', 'Suggest only', 'Act on internal tasks']

export function AgentsSettings() {
  const [card, setCard] = useState<AgentsCard | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    getAgentsCard().then((c) => { if (active) setCard(c) }).catch(() => {})
    return () => { active = false }
  }, [])

  if (!card) return null
  const disabled = !card.canManage || busy

  async function run(fn: () => Promise<{ error?: string }>, apply: (c: AgentsCard) => AgentsCard) {
    setBusy(true)
    const res = await fn()
    setBusy(false)
    if (res.error) setMsg(res.error)
    else { setMsg(null); setCard((c) => (c ? apply(c) : c)) }
  }

  return (
    <div className="rounded-xl border bg-card p-6 space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10"><Bot className="size-[18px] text-primary" /></div>
        <div>
          <h2 className="text-base font-semibold">AI agents</h2>
          <p className="text-xs text-muted-foreground">
            Choose what each agent may do. Everything starts off. Nothing is ever sent to a client without your approval, whatever you pick here.
          </p>
        </div>
      </div>

      <div className={`flex items-center justify-between rounded-lg border p-4 ${card.paused ? 'border-red-500/40 bg-red-500/10' : 'bg-muted/20'}`}>
        <div>
          <p className="text-sm font-medium">{card.paused ? 'All agents are paused' : 'Pause all agents'}</p>
          <p className="text-xs text-muted-foreground">One switch that stops every agent straight away.</p>
        </div>
        <Button size="sm" variant={card.paused ? 'default' : 'outline'} disabled={disabled}
          onClick={() => run(() => setAgentsPaused(!card.paused), (c) => ({ ...c, paused: !c.paused }))}>
          {card.paused ? 'Resume agents' : 'Pause all'}
        </Button>
      </div>

      <ul className="divide-y rounded-lg border">
        {AGENT_KEYS.map((k: AgentKey) => (
          <li key={k} className="flex items-center justify-between gap-4 p-3">
            <span className="text-sm font-medium">{AGENTS[k].label}{!AGENTS[k].live && <span className="ml-2 text-xs font-normal text-muted-foreground">Not active yet</span>}</span>
            <select className="h-9 rounded-md border bg-background px-3 text-sm disabled:opacity-60" disabled={disabled || !AGENTS[k].live} value={card.levels[k]}
              aria-label={`${AGENTS[k].label} level`}
              onChange={(e) => { const n = Number(e.target.value); run(() => setAgentLevel(k, n), (c) => ({ ...c, levels: { ...c.levels, [k]: n } })) }}>
              {LEVEL_LABEL.slice(0, AGENTS[k].maxLevel + 1).map((l, i) => <option key={l} value={i}>{l}</option>)}
            </select>
          </li>
        ))}
      </ul>
      {!card.canManage && <p className="text-xs text-muted-foreground">Only owners and admins can change these.</p>}
      {msg && <p role="alert" className="text-sm text-red-600">{msg}</p>}
    </div>
  )
}
