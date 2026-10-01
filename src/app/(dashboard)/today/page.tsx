'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { todayHeadline } from '@/lib/today'
import { getTodayBrief, type TodayBrief, type TodaySection } from './actions'
import {
  ShieldCheck, MessageSquareReply, FileSignature, Flame, Send, AlertTriangle, Coins, CheckCircle2,
} from 'lucide-react'

type SectionDef = {
  key: 'approvals' | 'replies' | 'proposals' | 'hotLeads' | 'followUps' | 'problems'
  title: string
  icon: React.ElementType
  empty: string
  viewAll?: { href: string; label: string }
  /** Counts that need the owner get an attention tone; informational ones stay neutral. */
  attention: boolean
}

const SECTIONS: SectionDef[] = [
  { key: 'approvals', title: 'Approvals waiting', icon: ShieldCheck, empty: 'Nothing waiting on your decision.', viewAll: { href: '/approvals', label: 'Open approvals' }, attention: true },
  { key: 'replies', title: 'Replies to answer', icon: MessageSquareReply, empty: 'No replies waiting. Nice.', attention: true },
  { key: 'proposals', title: 'Proposals to chase', icon: FileSignature, empty: 'No sent proposals are waiting on an answer.', viewAll: { href: '/proposals', label: 'Open proposals' }, attention: true },
  { key: 'hotLeads', title: 'Hot leads not yet contacted', icon: Flame, empty: 'Every hot lead has been contacted.', viewAll: { href: '/leads', label: 'Open leads' }, attention: false },
  { key: 'followUps', title: 'Follow-ups going out today', icon: Send, empty: 'No automated follow-ups are scheduled for today.', attention: false },
  { key: 'problems', title: 'Problems', icon: AlertTriangle, empty: 'No failed jobs in the last 24 hours.', viewAll: { href: '/jobs', label: 'Open jobs' }, attention: true },
]

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`

function SectionCard({ def, section }: { def: SectionDef; section: TodaySection }) {
  const Icon = def.icon
  const headingId = `today-${def.key}`
  const more = section.count - section.items.length
  return (
    <Card className="flex flex-col gap-3 p-5" role="region" aria-labelledby={headingId}>
      <div className="flex items-center justify-between gap-3">
        <h2 id={headingId} className="flex items-center gap-2 text-base font-semibold">
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          {def.title}
        </h2>
        <Badge tone={section.count > 0 && def.attention ? 'amber' : 'neutral'}>
          {section.count}
          <span className="sr-only"> {section.count === 1 ? 'item' : 'items'}</span>
        </Badge>
      </div>

      {section.count === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
          {def.empty}
        </p>
      ) : (
        <ul className="divide-y divide-border/50">
          {section.items.map((item) => (
            <li key={item.id}>
              <Link
                href={item.href}
                className="flex flex-col gap-0.5 rounded-md py-2 text-sm hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
              >
                <span className="font-medium break-words">{item.title}</span>
                {item.detail && <span className="line-clamp-2 text-xs text-muted-foreground break-words">{item.detail}</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}

      {section.count > 0 && def.viewAll && (
        <Link href={def.viewAll.href} className="text-xs font-medium text-primary underline-offset-2 hover:underline">
          {def.viewAll.label}
          {more > 0 && ` (${more} more)`}
        </Link>
      )}
    </Card>
  )
}

function SpendCard({ spend }: { spend: TodayBrief['aiSpend'] }) {
  const pct = spend.capCents > 0 ? Math.min(100, Math.round((spend.todayCents / spend.capCents) * 100)) : 0
  const over = spend.todayCents >= spend.capCents
  return (
    <Card className="flex flex-col gap-3 p-5" role="region" aria-labelledby="today-ai-spend">
      <h2 id="today-ai-spend" className="flex items-center gap-2 text-base font-semibold">
        <Coins className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        AI spend
      </h2>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">Today</dt>
          <dd className="text-lg font-semibold">{usd(spend.todayCents)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Last 7 days</dt>
          <dd className="text-lg font-semibold">{usd(spend.last7DaysCents)}</dd>
        </div>
      </dl>
      <div>
        <div
          role="progressbar"
          aria-label="Today's AI spend against the daily cap"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-valuetext={`${usd(spend.todayCents)} of ${usd(spend.capCents)}`}
          className="h-2 overflow-hidden rounded-full bg-muted"
        >
          <div className={`h-full ${over ? 'bg-destructive' : 'bg-primary'}`} style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {usd(spend.todayCents)} of {usd(spend.capCents)} daily cap{over ? ' (cap reached)' : ''}
        </p>
      </div>
    </Card>
  )
}

export default function TodayPage() {
  const [brief, setBrief] = useState<TodayBrief | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let active = true
    getTodayBrief()
      .then((b) => { if (active) setBrief(b) })
      .catch(() => { if (active) setFailed(true) })
    return () => { active = false }
  }, [])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Today</h1>
        <p className="mt-0.5 text-sm text-muted-foreground" aria-live="polite">
          {brief ? todayHeadline(brief.counts) : failed ? 'Could not load your brief. Try refreshing.' : 'Loading your brief…'}
        </p>
      </div>

      {!brief && !failed ? (
        <div className="grid gap-4 md:grid-cols-2" aria-busy="true">
          {Array.from({ length: 7 }).map((_, i) => (
            <Card key={i} className="flex flex-col gap-3 p-5">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-4 w-full max-w-sm" />
              <Skeleton className="h-4 w-2/3" />
            </Card>
          ))}
        </div>
      ) : brief ? (
        <div className="grid gap-4 md:grid-cols-2">
          {SECTIONS.map((def) => <SectionCard key={def.key} def={def} section={brief[def.key]} />)}
          <SpendCard spend={brief.aiSpend} />
        </div>
      ) : null}
    </div>
  )
}
