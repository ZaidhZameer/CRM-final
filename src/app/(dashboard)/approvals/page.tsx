'use client'

import { useState, useEffect } from 'react'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { getApprovals, decideApprovalAction, type ApprovalRow } from './actions'
import { CheckCircle2, AlertTriangle, ShieldCheck, FileWarning } from 'lucide-react'
import { useToast } from '@/components/ui/toast'

type BadgeTone = React.ComponentProps<typeof Badge>['tone']

const TIER_BADGES: Record<string, { label: string, tone: BadgeTone, icon: React.ElementType }> = {
  review: { label: 'Needs review', tone: 'orange', icon: FileWarning },
  always_human: { label: 'Always human', tone: 'red', icon: ShieldCheck }
}

const STATUS_COLORS: Record<string, BadgeTone> = {
  pending: 'amber',
  approved: 'emerald',
  rejected: 'red',
  executed: 'blue',
  expired: 'neutral',
  cancelled: 'neutral',
}

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState<ApprovalRow[]>([])
  const [loading, setLoading] = useState(true)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState<Record<string, boolean>>({})
  const { toast } = useToast()

  async function load() {
    setLoading(true)
    const result = await getApprovals()
    setApprovals(result.approvals)
    setLoading(false)
  }

  useEffect(() => {
    let active = true
    async function doLoad() {
      setLoading(true)
      const result = await getApprovals()
      if (active) {
        setApprovals(result.approvals)
        setLoading(false)
      }
    }
    doLoad()
    return () => { active = false }
  }, [])

  // Edits to a follow-up email before approving; sent as the RPC's edited payload.
  const [edits, setEdits] = useState<Record<string, { subject: string; body: string }>>({})
  const editFor = (a: ApprovalRow) => {
    const p = (a.payload_json ?? {}) as { subject?: string; body?: string }
    return edits[a.id] ?? { subject: p.subject ?? '', body: p.body ?? '' }
  }

  async function handleDecision(id: string, decision: 'approved' | 'rejected', version: number) {
    setSubmitting(prev => ({ ...prev, [id]: true }))
    const note = notes[id] || undefined
    const approval = approvals.find((a) => a.id === id)
    const original = (approval?.payload_json ?? {}) as { subject?: string; body?: string }
    const edit = edits[id]
    const changed = edit && (edit.subject !== (original.subject ?? '') || edit.body !== (original.body ?? ''))
    const res = await decideApprovalAction(id, decision, version, note, changed ? { ...original, ...edit } : undefined)
    setSubmitting(prev => ({ ...prev, [id]: false }))

    if (res.error) {
      toast({ variant: 'error', title: 'Action failed', description: res.error })
    } else {
      toast({ variant: 'success', title: `Approval ${decision}`, description: 'Your decision has been recorded.' })
      await load()
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Approvals</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Review and decide on AI actions.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="space-y-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="flex flex-col gap-3 p-5">
              <div className="flex justify-between">
                <Skeleton className="h-5 w-48" />
                <Skeleton className="h-5 w-24 rounded-full" />
              </div>
              <Skeleton className="h-4 w-full max-w-lg" />
              <div className="flex gap-2">
                <Skeleton className="h-8 w-24" />
                <Skeleton className="h-8 w-24" />
              </div>
            </Card>
          ))}
        </div>
      ) : approvals.length === 0 ? (
        <div className="rounded-xl border bg-card p-12 text-center">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-muted">
            <CheckCircle2 className="size-5 text-muted-foreground" />
          </div>
          <p className="mt-3 text-sm text-muted-foreground">No approvals found.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {approvals.map(approval => {
            const tierInfo = TIER_BADGES[approval.tier] || { label: approval.tier, tone: 'neutral', icon: AlertTriangle }
            const TierIcon = tierInfo.icon
            const isPending = approval.status === 'pending'
            
            return (
              <Card key={approval.id} className="flex flex-col gap-4 p-5">
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <span className="font-mono text-xs uppercase tracking-wider">{approval.action_type}</span>
                      <span>•</span>
                      <span>Created {new Date(approval.created_at).toLocaleString()}</span>
                      {approval.expires_at && isPending && (
                        <>
                          <span>•</span>
                          <span className={new Date(approval.expires_at) < new Date() ? 'text-destructive font-medium' : ''}>
                            Expires {new Date(approval.expires_at).toLocaleString()}
                          </span>
                        </>
                      )}
                    </div>
                    <h3 className="text-lg font-semibold">{approval.title}</h3>
                    {approval.summary && (
                      <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
                        {approval.summary}
                      </p>
                    )}
                    {approval.action_type === 'send_follow_up_email' && isPending && (
                      <div className="mt-3 max-w-3xl space-y-2 rounded-md border bg-muted/30 p-3">
                        <p className="text-xs text-muted-foreground">
                          To: <span className="font-medium text-foreground">{String((approval.payload_json as { to?: string } | null)?.to ?? '')}</span>
                          <span className="ml-2">Edit freely; approving sends your version at the scheduled time.</span>
                        </p>
                        <Input
                          aria-label="Email subject"
                          className="h-9 text-sm"
                          value={editFor(approval).subject}
                          onChange={(e) => setEdits((prev) => ({ ...prev, [approval.id]: { ...editFor(approval), subject: e.target.value } }))}
                          disabled={submitting[approval.id]}
                        />
                        <textarea
                          aria-label="Email body"
                          className="min-h-48 w-full rounded-md border bg-background p-3 text-sm leading-relaxed"
                          value={editFor(approval).body}
                          onChange={(e) => setEdits((prev) => ({ ...prev, [approval.id]: { ...editFor(approval), body: e.target.value } }))}
                          disabled={submitting[approval.id]}
                        />
                      </div>
                    )}
                    {approval.action_type !== 'send_follow_up_email' && approval.payload_json && Object.keys(approval.payload_json).length > 0 && (
                      <details className="mt-2 max-w-3xl" open={isPending}>
                        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                          What will happen if approved
                        </summary>
                        <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap break-words">
                          {JSON.stringify(approval.payload_json, null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-2 shrink-0">
                    <Badge tone={tierInfo.tone} className="flex items-center gap-1 w-max">
                      <TierIcon className="size-3" />
                      {tierInfo.label}
                    </Badge>
                    <Badge tone={STATUS_COLORS[approval.status]} className="capitalize w-max">
                      {approval.status}
                    </Badge>
                  </div>
                </div>

                {isPending && (
                  <div className="flex flex-col sm:flex-row gap-3 pt-2 border-t border-border/50">
                    <Input 
                      placeholder="Optional note..."
                      className="max-w-md h-9 text-sm"
                      value={notes[approval.id] || ''}
                      onChange={e => setNotes(prev => ({ ...prev, [approval.id]: e.target.value }))}
                      disabled={submitting[approval.id]}
                    />
                    <div className="flex gap-2">
                      <Button
                        variant="default"
                        className="h-9 px-4 bg-emerald-600 hover:bg-emerald-700 text-white"
                        disabled={submitting[approval.id]}
                        onClick={() => handleDecision(approval.id, 'approved', approval.version)}
                      >
                        {submitting[approval.id] ? 'Saving...' : 'Approve'}
                      </Button>
                      <Button
                        variant="destructive"
                        className="h-9 px-4"
                        disabled={submitting[approval.id]}
                        onClick={() => handleDecision(approval.id, 'rejected', approval.version)}
                      >
                        {submitting[approval.id] ? 'Saving...' : 'Reject'}
                      </Button>
                    </div>
                  </div>
                )}
                {!isPending && approval.decision_note && (
                  <div className="pt-2 border-t border-border/50 text-sm text-muted-foreground">
                    <strong>Note:</strong> {approval.decision_note}
                  </div>
                )}
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
