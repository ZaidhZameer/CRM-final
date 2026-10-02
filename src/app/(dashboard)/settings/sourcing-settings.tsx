'use client'

import { useEffect, useState } from 'react'
import { Radar } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SIC_PRESETS } from '@/lib/sourcing/presets'
import { cleanSicCodes } from '@/lib/sourcing/presets'
import type { SourcingSettingsInput } from '@/lib/sourcing/settings'
import { getSourcingCard, saveSourcingSettings, type SourcingCard } from './sourcing-actions'

const field = 'h-9 w-full rounded-md border bg-background px-3 text-sm disabled:opacity-60'

export function SourcingSettings() {
  const [card, setCard] = useState<SourcingCard | null>(null)
  const [form, setForm] = useState<SourcingSettingsInput | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    let active = true
    getSourcingCard().then((c) => { if (active) { setCard(c); setForm(c.settings) } }).catch(() => {})
    return () => { active = false }
  }, [])

  if (!card || !form) return null
  const disabled = !card.canManage || busy
  const presets = SIC_PRESETS.filter((p) => p.campaign === form.campaign)
  const set = (patch: Partial<SourcingSettingsInput>) => { setForm({ ...form, ...patch }); setMsg(null) }

  function togglePreset(codes: string[]) {
    const all = codes.every((c) => form!.sic_codes.includes(c))
    set({ sic_codes: all ? form!.sic_codes.filter((c) => !codes.includes(c)) : cleanSicCodes([...form!.sic_codes, ...codes]) })
  }

  async function save() {
    setBusy(true)
    const res = await saveSourcingSettings(form!)
    setBusy(false)
    setMsg(res.error ? { ok: false, text: res.error } : { ok: true, text: form!.enabled ? 'Saved. Sourcing runs once a day.' : 'Saved. Sourcing is off.' })
  }

  return (
    <div className="rounded-xl border bg-card p-6 space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10"><Radar className="size-[18px] text-primary" /></div>
        <div>
          <h2 className="text-base font-semibold">Lead sourcing</h2>
          <p className="text-xs text-muted-foreground">
            Finds established UK limited companies in the industries you choose and adds them as leads. Companies House data is public and every result is a
            limited company, so UK email rules allow business-to-business outreach. It only creates leads; it never sends an email.
          </p>
        </div>
      </div>

      {!card.keyConfigured && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-600">
          No Companies House API key is set on the server yet, so nothing will be found. (Free key: developer.company-information.service.gov.uk.)
        </div>
      )}

      <div className="flex items-center justify-between rounded-lg border bg-muted/20 p-4">
        <div>
          <p className="text-sm font-medium">Find new leads every day</p>
          <p className="text-xs text-muted-foreground">Last 7 days: {card.foundLast7Days} companies checked, {card.createdLast7Days} leads added.</p>
        </div>
        <label className="flex items-center gap-2 text-xs font-medium">
          <input type="checkbox" className="size-4 accent-primary" checked={form.enabled} disabled={disabled} onChange={(e) => set({ enabled: e.target.checked })} />
          {form.enabled ? 'On' : 'Off'}
        </label>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">Who are you looking for?</label>
        <select aria-label="Campaign" className={field} value={form.campaign} disabled={disabled} onChange={(e) => set({ campaign: e.target.value, sic_codes: [] })}>
          <option value="websites">Local businesses that need websites and automation</option>
          <option value="agencies">Small agencies and web businesses (potential FlowLead customers)</option>
        </select>
        <div className="flex flex-wrap gap-2">
          {presets.map((p) => {
            const on = p.sicCodes.every((c) => form.sic_codes.includes(c))
            return (
              <button key={p.key} type="button" disabled={disabled} aria-pressed={on} onClick={() => togglePreset(p.sicCodes)}
                className={`rounded-full border px-3 py-1 text-xs ${on ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground'}`}>
                {p.label}
              </button>
            )
          })}
        </div>
        <input aria-label="SIC codes" className={field} disabled={disabled} placeholder="Or type SIC codes, comma separated (e.g. 86230, 69102)"
          value={form.sic_codes.join(', ')} onChange={(e) => set({ sic_codes: e.target.value.split(/[,\s]+/).filter(Boolean) })} />
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <div className="sm:col-span-2 space-y-1"><label className="text-xs text-muted-foreground">Area (town or postcode area; empty = whole UK)</label>
          <input aria-label="Area" className={field} disabled={disabled} value={form.location} onChange={(e) => set({ location: e.target.value })} /></div>
        <div className="space-y-1"><label className="text-xs text-muted-foreground">Company age (years)</label>
          <div className="flex gap-2">
            <input aria-label="Minimum age" type="number" min={0} className={field} disabled={disabled} value={form.min_age_years} onChange={(e) => set({ min_age_years: Number(e.target.value) })} />
            <input aria-label="Maximum age" type="number" min={0} className={field} disabled={disabled} value={form.max_age_years} onChange={(e) => set({ max_age_years: Number(e.target.value) })} />
          </div></div>
        <div className="space-y-1"><label className="text-xs text-muted-foreground">New leads per day</label>
          <input aria-label="Daily limit" type="number" min={1} max={50} className={field} disabled={disabled} value={form.daily_cap} onChange={(e) => set({ daily_cap: Number(e.target.value) })} /></div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className={`text-xs ${msg ? (msg.ok ? 'text-emerald-600' : 'text-destructive') : 'text-muted-foreground'}`}>
          {msg?.text ?? (card.canManage ? '' : 'Only owners and admins can change this.')}
        </p>
        {card.canManage && <Button size="sm" className="text-xs" disabled={busy} onClick={save}>Save</Button>}
      </div>
    </div>
  )
}
