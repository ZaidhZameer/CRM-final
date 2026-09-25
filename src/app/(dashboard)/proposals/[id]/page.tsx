'use client'

import { use, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Copy, ExternalLink, Loader2, ShieldCheck } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/toast'
import {
  getProposal, saveProposal, approveProposal, markProposalSent, recordProposalOutcome, withdrawProposal,
  type ProposalDetail,
} from '../actions'
import { STATUS_TONES, formatPrice } from '../format'

const TEXT_SECTIONS: { key: 'summary' | 'situation' | 'solution' | 'timeline' | 'next_steps'; label: string }[] = [
  { key: 'summary', label: 'Summary' },
  { key: 'situation', label: 'Your situation' },
  { key: 'solution', label: 'What we propose' },
  { key: 'timeline', label: 'Timeline' },
  { key: 'next_steps', label: 'Next steps' },
]

const area = 'w-full rounded-md border bg-background p-3 text-sm leading-relaxed disabled:opacity-70'

export default function ProposalEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { toast } = useToast()
  const [p, setP] = useState<ProposalDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)

  const load = useCallback(async () => {
    const res = await getProposal(id)
    if (res.error) setError(res.error)
    else { setP(res.proposal!); setDirty(false) }
  }, [id])

  useEffect(() => {
    let active = true
    getProposal(id).then((res) => {
      if (!active) return
      if (res.error) setError(res.error)
      else setP(res.proposal!)
    })
    return () => { active = false }
  }, [id])

  // While the AI is still writing, check back every few seconds.
  useEffect(() => {
    if (!p?.drafting) return
    const t = setInterval(load, 4000)
    return () => clearInterval(t)
  }, [p?.drafting, load])

  if (error) return <Card className="p-8 text-center text-sm text-muted-foreground">{error}</Card>
  if (!p) return <div className="space-y-4"><Skeleton className="h-10 w-1/2" /><Skeleton className="h-96 w-full" /></div>

  const editable = p.status === 'draft'
  const set = (patch: Partial<ProposalDetail>) => { setP({ ...p, ...patch }); setDirty(true) }
  const setSection = (k: keyof ProposalDetail['sections'], v: string | string[]) => set({ sections: { ...p.sections, [k]: v } })
  const shareUrl = typeof window !== 'undefined' ? `${window.location.origin}/p/${p.share_token}` : `/p/${p.share_token}`

  async function run(action: () => Promise<{ error?: string }>, ok: string) {
    setBusy(true)
    const res = await action()
    setBusy(false)
    if (res.error) toast({ variant: 'error', title: 'Not done', description: res.error })
    else { toast({ variant: 'success', title: ok }); await load() }
  }

  async function save(): Promise<{ error?: string }> {
    if (!p) return { error: 'Not loaded' }
    const res = await saveProposal(p.id, {
      title: p.title, sections: p.sections, price_amount: p.price_amount, currency: p.currency,
      price_type: p.price_type, price_notes: p.price_notes, valid_until: p.valid_until,
    }, p.version)
    return res.error ? { error: res.error } : {}
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/proposals" className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> Proposals
        </Link>
        <div className="flex items-center gap-2">
          {p.drafted_by_ai && <Badge tone="neutral">AI draft</Badge>}
          <Badge tone={STATUS_TONES[p.status] ?? 'neutral'} className="capitalize">{p.status}</Badge>
        </div>
      </div>

      {p.drafting && (
        <Card className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> The AI is writing this proposal from your research and meeting notes…
        </Card>
      )}

      <Card className="space-y-5 p-6">
        <Input aria-label="Proposal title" className="h-11 text-lg font-semibold" value={p.title} disabled={!editable || busy} onChange={(e) => set({ title: e.target.value })} />
        <p className="text-xs text-muted-foreground">For {p.company ?? 'this lead'}. Edit anything. Pricing goes only in the price box below. The AI never sets it.</p>

        {TEXT_SECTIONS.map(({ key, label }) => (
          <div key={key} className="space-y-1.5">
            <label className="text-sm font-medium">{label}</label>
            <textarea aria-label={label} className={`${area} min-h-24`} value={p.sections[key]} disabled={!editable || busy} onChange={(e) => setSection(key, e.target.value)} />
          </div>
        ))}
        {(['scope', 'assumptions'] as const).map((k) => (
          <div key={k} className="space-y-1.5">
            <label className="text-sm font-medium">{k === 'scope' ? 'Scope & deliverables' : 'Assumptions'} <span className="font-normal text-muted-foreground">(one per line)</span></label>
            <textarea aria-label={k} className={`${area} min-h-24`} value={p.sections[k].join('\n')} disabled={!editable || busy} onChange={(e) => setSection(k, e.target.value.split('\n'))} />
          </div>
        ))}
      </Card>

      <Card className="space-y-4 border-primary/30 p-6">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-primary" />
          <h2 className="text-base font-semibold">Price (you set this)</h2>
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <Input aria-label="Price" type="number" min="0" step="0.01" placeholder="e.g. 2400" className="sm:col-span-2"
            value={p.price_amount ?? ''} disabled={!editable || busy}
            onChange={(e) => set({ price_amount: e.target.value === '' ? null : Number(e.target.value) })} />
          <select aria-label="Currency" className="h-9 rounded-md border bg-background px-2 text-sm" value={p.currency} disabled={!editable || busy} onChange={(e) => set({ currency: e.target.value })}>
            <option value="GBP">GBP</option><option value="EUR">EUR</option><option value="USD">USD</option>
          </select>
          <select aria-label="Price type" className="h-9 rounded-md border bg-background px-2 text-sm" value={p.price_type} disabled={!editable || busy} onChange={(e) => set({ price_type: e.target.value })}>
            <option value="one_off">One-off</option><option value="monthly">Per month</option>
          </select>
        </div>
        <Input aria-label="Price notes" placeholder="Optional: payment terms, e.g. 50% upfront" value={p.price_notes ?? ''} disabled={!editable || busy} onChange={(e) => set({ price_notes: e.target.value })} />
        <div className="flex items-center gap-3 text-sm">
          <label className="text-muted-foreground">Valid until</label>
          <Input aria-label="Valid until" type="date" className="w-44" value={p.valid_until ?? ''} disabled={!editable || busy} onChange={(e) => set({ valid_until: e.target.value })} />
          <span className="ml-auto font-medium tabular-nums">{formatPrice(p)}</span>
        </div>
      </Card>

      <Card className="flex flex-wrap items-center gap-2 p-4">
        {editable && (
          <>
            <Button variant="outline" disabled={busy || !dirty} onClick={() => run(save, 'Saved')}>Save</Button>
            <Button className="bg-emerald-600 text-white hover:bg-emerald-700" disabled={busy}
              onClick={() => run(async () => { if (dirty) { const s = await save(); if (s.error) return s } return approveProposal(p.id) }, 'Approved. Share the link or print it to PDF.')}>
              Approve
            </Button>
          </>
        )}
        {['approved', 'sent', 'accepted'].includes(p.status) && (
          <>
            <Button variant="outline" className="gap-1.5" onClick={() => { navigator.clipboard.writeText(shareUrl); toast({ variant: 'success', title: 'Link copied' }) }}>
              <Copy className="size-4" /> Copy client link
            </Button>
            <a href={`/p/${p.share_token}`} target="_blank" rel="noreferrer"><Button variant="outline" className="gap-1.5"><ExternalLink className="size-4" /> View / print</Button></a>
          </>
        )}
        {p.status === 'approved' && <Button disabled={busy} onClick={() => run(() => markProposalSent(p.id), 'Marked as sent. Lead moved to Proposal Sent.')}>Mark as sent</Button>}
        {p.status === 'sent' && (
          <>
            <Button className="bg-emerald-600 text-white hover:bg-emerald-700" disabled={busy} onClick={() => run(() => recordProposalOutcome(p.id, 'accepted'), 'Accepted. Deal marked won.')}>Accepted</Button>
            <Button variant="outline" disabled={busy} onClick={() => { const r = window.prompt('Why did they decline? (optional)') ?? undefined; run(() => recordProposalOutcome(p.id, 'declined', r), 'Recorded as declined.') }}>Declined</Button>
          </>
        )}
        {!['accepted', 'declined', 'withdrawn'].includes(p.status) && (
          <Button variant="ghost" className="ml-auto text-muted-foreground" disabled={busy} onClick={() => { if (window.confirm('Withdraw this proposal?')) run(() => withdrawProposal(p.id), 'Withdrawn') }}>Withdraw</Button>
        )}
        {p.status === 'declined' && p.decline_reason && <p className="text-sm text-muted-foreground">Declined: {p.decline_reason}</p>}
      </Card>
    </div>
  )
}
