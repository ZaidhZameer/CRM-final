'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { FileText } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { getProposals, type ProposalListRow } from './actions'
import { STATUS_TONES, formatPrice } from './format'


export default function ProposalsPage() {
  const [rows, setRows] = useState<ProposalListRow[] | null>(null)

  useEffect(() => {
    let active = true
    getProposals().then((r) => { if (active) setRows(r.proposals) }).catch(() => { if (active) setRows([]) })
    return () => { active = false }
  }, [])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Proposals</h1>
        <p className="text-sm text-muted-foreground">AI drafts the words from your research and meeting notes. You set the price and approve every proposal.</p>
      </div>

      {rows === null ? (
        <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>
      ) : rows.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 p-10 text-center">
          <FileText className="size-8 text-muted-foreground/50" />
          <p className="text-sm font-medium">No proposals yet</p>
          <p className="text-xs text-muted-foreground">Open a lead and choose &ldquo;Draft proposal&rdquo;.</p>
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((p) => (
            <Link key={p.id} href={`/proposals/${p.id}`} className="block">
              <Card className="flex items-center justify-between gap-4 p-4 transition-colors hover:bg-muted/30">
                <div className="min-w-0">
                  <p className="truncate font-medium">{p.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {p.company ?? 'Unknown company'} · created {new Date(p.created_at).toLocaleDateString('en-GB')}
                    {p.sent_at ? ` · sent ${new Date(p.sent_at).toLocaleDateString('en-GB')}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="text-sm tabular-nums text-muted-foreground">{formatPrice(p)}</span>
                  <Badge tone={STATUS_TONES[p.status] ?? 'neutral'} className="capitalize">{p.status}</Badge>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
