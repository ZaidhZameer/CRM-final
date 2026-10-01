'use client'

import { useState, useEffect, use } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { getLeadDetail, updateLeadStatus, addNote, addReply } from './actions'
import { runAIResearch } from './ai-actions'
import { softDeleteLead } from '../../trash/actions'
import { draftProposal } from '../../proposals/actions'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { useToast } from '@/components/ui/toast'
import Link from 'next/link'

const QUALITY_STYLES: Record<string, string> = {
  hot: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  warm: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  cold: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
}

const STATUS_OPTIONS = ['new', 'contacted', 'qualified', 'unqualified', 'nurture', 'converted', 'lost']

const AI_STATUS_STYLES: Record<string, string> = {
  pending: 'bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-400',
  running: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  completed: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  failed: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
}

const ACTION_LABELS: Record<string, string> = {
  created: 'Created',
  updated: 'Updated',
  imported: 'Imported from CSV',
  scored: 'Score updated',
  researched: 'AI research completed',
  deleted: 'Deleted',
  restored: 'Restored',
}

export default function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const confirm = useConfirm()
  const { toast } = useToast()
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [noteText, setNoteText] = useState('')
  const [savingNote, setSavingNote] = useState(false)
  const [statusUpdating, setStatusUpdating] = useState(false)
  const [aiRunning, setAiRunning] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [drafting, setDrafting] = useState(false)
  const [briefOpen, setBriefOpen] = useState(false)
  const [brief, setBrief] = useState('')

  async function load() {
    const result = await getLeadDetail(id)
    if ('error' in result) {
      return
    }
    setData(result)
    setLoading(false)
  }

  useEffect(() => { load() }, [id])

  async function handleStatusChange(newStatus: string) {
    setStatusUpdating(true)
    await updateLeadStatus(id, newStatus)
    await load()
    setStatusUpdating(false)
  }

  async function handleAddNote() {
    if (!noteText.trim()) return
    setSavingNote(true)
    await addNote(id, noteText.trim())
    setNoteText('')
    await load()
    setSavingNote(false)
  }

  async function handleRunAI(tier: 'basic' | 'standard') {
    setAiRunning(true)
    setAiError(null)
    const result = await runAIResearch(id, tier)
    if ('error' in result && result.error) {
      setAiError(result.error)
    }
    await load()
    setAiRunning(false)
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    )
  }

  if (!data?.lead) {
    return (
      <div className="space-y-4">
        <p className="text-muted-foreground">Lead not found.</p>
        <Link href="/leads"><Button variant="outline">Back to Leads</Button></Link>
      </div>
    )
  }

  const { lead, research, activities, notes } = data
  const company = lead.companies
  const contact = lead.contacts

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <Link href="/leads" className="text-sm text-muted-foreground hover:text-foreground">
            &larr; Back to Leads
          </Link>
          <h1 className="mt-1 text-2xl font-bold">
            {company?.name || contact?.full_name || 'Unknown Lead'}
          </h1>
          {company?.name && contact?.full_name && (
            <p className="text-sm text-muted-foreground">{contact.full_name}</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium capitalize ${QUALITY_STYLES[lead.lead_quality] ?? ''}`}>
            {lead.lead_quality}
          </span>
          <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-bold">
            Score: {lead.lead_score}
          </span>
          <Button size="sm" disabled={drafting} onClick={() => setBriefOpen((o) => !o)}>
            Draft proposal
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
            onClick={async () => {
              const ok = await confirm({
                title: 'Move lead to trash?',
                description: 'You can restore it from Trash later.',
                confirmLabel: 'Move to trash',
                variant: 'danger',
              })
              if (!ok) return
              const result = await softDeleteLead(id)
              if (result && 'error' in result && result.error) {
                toast({ variant: 'error', title: 'Could not delete', description: String(result.error) })
                return
              }
              toast({ variant: 'success', title: 'Moved to trash' })
              router.push('/leads')
            }}
          >
            Delete
          </Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {briefOpen && (
        <div className="space-y-3 rounded-xl border bg-card p-4">
          <div>
            <p className="text-sm font-medium">Draft a proposal</p>
            <p className="text-xs text-muted-foreground">
              The AI writes it from this lead&apos;s research, latest meeting notes and enquiry. You edit it and set the price before anything is shared.
            </p>
          </div>
          <textarea
            aria-label="Proposal brief"
            className="min-h-20 w-full rounded-md border bg-background p-3 text-sm"
            placeholder="Optional brief: what must it cover? e.g. new website + booking automation, budget around 3k"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            disabled={drafting}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={drafting}
              onClick={async () => {
                setDrafting(true)
                const res = await draftProposal(id, brief.trim() || undefined)
                setDrafting(false)
                if (res.proposalId) {
                  if (res.error) toast({ variant: 'error', title: 'Draft created without AI', description: res.error })
                  router.push(`/proposals/${res.proposalId}`)
                } else toast({ variant: 'error', title: 'Could not start a proposal', description: res.error })
              }}
            >
              {drafting ? 'Starting…' : 'Start draft'}
            </Button>
            <Button size="sm" variant="ghost" disabled={drafting} onClick={() => setBriefOpen(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {/* Left column — main info */}
        <div className="space-y-6 lg:col-span-2">
          {/* Status */}
          <div className="rounded-lg border p-4">
            <h2 className="mb-3 text-sm font-medium text-muted-foreground">Status</h2>
            <div className="flex flex-wrap gap-2">
              {STATUS_OPTIONS.map(s => (
                <button
                  key={s}
                  onClick={() => handleStatusChange(s)}
                  disabled={statusUpdating}
                  className={`rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors ${
                    lead.status === s
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground hover:bg-muted/80'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* Company Info */}
          {company && (
            <div className="rounded-lg border p-4">
              <h2 className="mb-3 text-sm font-medium text-muted-foreground">Company</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                <InfoRow label="Name" value={company.name} />
                <InfoRow label="Website" value={company.website} link />
                <InfoRow label="Industry" value={company.industry} />
                <InfoRow label="Size" value={company.size_band} />
                <InfoRow label="Location" value={company.location} />
              </div>
              {company.ai_summary && (
                <div className="mt-3 rounded-md bg-muted/50 p-3">
                  <p className="text-xs font-medium text-muted-foreground">AI Summary</p>
                  <p className="mt-1 text-sm">{company.ai_summary}</p>
                </div>
              )}
            </div>
          )}

          {/* Contact Info */}
          {contact && (
            <div className="rounded-lg border p-4">
              <h2 className="mb-3 text-sm font-medium text-muted-foreground">Contact</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                <InfoRow label="Name" value={contact.full_name} />
                <InfoRow label="Email" value={contact.email} />
                <InfoRow label="Phone" value={contact.phone} />
                <InfoRow label="Job Title" value={contact.job_title} />
                <InfoRow label="LinkedIn" value={contact.linkedin_url} link />
                <InfoRow label="Decision Maker" value={contact.is_decision_maker ? 'Yes' : 'No'} />
              </div>
            </div>
          )}

          {/* AI Research */}
          <div className="rounded-lg border p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-medium text-muted-foreground">AI Research</h2>
                <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize ${AI_STATUS_STYLES[lead.ai_status] ?? ''}`}>
                  {lead.ai_status}
                </span>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={aiRunning}
                  onClick={() => handleRunAI('basic')}
                >
                  {aiRunning ? 'Running...' : 'Basic Research'}
                </Button>
                <Button
                  size="sm"
                  disabled={aiRunning}
                  onClick={() => handleRunAI('standard')}
                >
                  {aiRunning ? 'Running...' : 'Standard Research'}
                </Button>
              </div>
            </div>
            {aiError && (
              <div className="mb-3 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {aiError}
              </div>
            )}
            {research ? (
              <div className="space-y-4">
                {research.company_summary && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">Company Summary</p>
                    <p className="mt-1 text-sm">{research.company_summary}</p>
                  </div>
                )}
                {research.website_analysis && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">Website Analysis</p>
                    <p className="mt-1 text-sm">{research.website_analysis}</p>
                  </div>
                )}
                {research.pain_points_json && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">Pain Points</p>
                    <ul className="mt-1 list-inside list-disc text-sm">
                      {(research.pain_points_json as string[]).map((p: string, i: number) => (
                        <li key={i}>{p}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {research.recommended_offer && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">Recommended Offer</p>
                    <p className="mt-1 text-sm">{research.recommended_offer}</p>
                  </div>
                )}
                {research.outreach_angle && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">Outreach Angle</p>
                    <p className="mt-1 text-sm">{research.outreach_angle}</p>
                  </div>
                )}
                {research.next_best_action && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">Next Best Action</p>
                    <p className="mt-1 text-sm font-medium">{research.next_best_action}</p>
                  </div>
                )}
                {research.confidence_score != null && (
                  <div className="flex items-center gap-4 text-sm text-muted-foreground">
                    <span>AI Score: {research.lead_score}</span>
                    <span>Confidence: {Math.round(research.confidence_score * 100)}%</span>
                    <span>Model: {research.model}</span>
                    <span className="capitalize">Tier: {research.tier}</span>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {lead.ai_status === 'pending'
                  ? 'AI research has not started yet. It will run automatically.'
                  : lead.ai_status === 'running'
                  ? 'AI research is in progress...'
                  : 'No research available.'}
              </p>
            )}
          </div>

          {/* Comments (threaded) */}
          <div className="rounded-lg border p-4">
            <h2 className="mb-3 text-sm font-medium text-muted-foreground">
              Comments ({notes.length})
            </h2>
            <div className="space-y-3">
              {/* New comment box */}
              <div className="flex gap-2">
                <textarea
                  value={noteText}
                  onChange={e => setNoteText(e.target.value)}
                  placeholder="Add a comment..."
                  rows={2}
                  className="flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground"
                />
                <Button onClick={handleAddNote} disabled={!noteText.trim() || savingNote} size="sm">
                  {savingNote ? '...' : 'Post'}
                </Button>
              </div>

              {notes.length === 0 ? (
                <p className="text-sm text-muted-foreground">No comments yet. Start the conversation.</p>
              ) : (
                <CommentThread
                  comments={notes}
                  leadId={id}
                  onReplyAdded={load}
                />
              )}
            </div>
          </div>
        </div>

        {/* Right column — sidebar */}
        <div className="space-y-6">
          {/* Quick Info */}
          <div className="rounded-lg border p-4">
            <h2 className="mb-3 text-sm font-medium text-muted-foreground">Details</h2>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Source</span>
                <span>{lead.source ?? '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Created</span>
                <span>{new Date(lead.created_at).toLocaleDateString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Last Updated</span>
                <span>{new Date(lead.updated_at).toLocaleDateString()}</span>
              </div>
              {lead.last_contacted_at && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Last Contacted</span>
                  <span>{new Date(lead.last_contacted_at).toLocaleDateString()}</span>
                </div>
              )}
              {lead.next_follow_up_at && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Follow Up</span>
                  <span>{new Date(lead.next_follow_up_at).toLocaleDateString()}</span>
                </div>
              )}
            </div>
          </div>

          {/* Score Breakdown */}
          <div className="rounded-lg border p-4">
            <h2 className="mb-3 text-sm font-medium text-muted-foreground">Lead Score</h2>
            <div className="mb-3 text-center">
              <span className="text-4xl font-bold">{lead.lead_score}</span>
              <span className="text-lg text-muted-foreground">/100</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full transition-all ${
                  lead.lead_score >= 60 ? 'bg-red-500' : lead.lead_score >= 35 ? 'bg-orange-500' : 'bg-blue-500'
                }`}
                style={{ width: `${lead.lead_score}%` }}
              />
            </div>
          </div>

          {/* Activity Timeline */}
          <div className="rounded-lg border p-4">
            <h2 className="mb-3 text-sm font-medium text-muted-foreground">Activity</h2>
            {activities.length === 0 ? (
              <p className="text-sm text-muted-foreground">No activity yet.</p>
            ) : (
              <div className="space-y-3">
                {activities.map((a: any) => (
                  <div key={a.id} className="flex gap-3 text-sm">
                    <div className="mt-1 h-2 w-2 shrink-0 rounded-full bg-primary" />
                    <div>
                      <p>{ACTION_LABELS[a.action] ?? a.action}</p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(a.created_at).toLocaleString()}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function CommentThread({
  comments,
  leadId,
  onReplyAdded,
}: {
  comments: any[]
  leadId: string
  onReplyAdded: () => void
}) {
  const [replyingTo, setReplyingTo] = useState<string | null>(null)
  const [replyText, setReplyText] = useState('')
  const [saving, setSaving] = useState(false)

  // Separate top-level comments and replies
  const topLevel = comments.filter((c: any) => !c.parentId)
  const repliesMap = new Map<string, any[]>()
  comments.filter((c: any) => c.parentId).forEach((c: any) => {
    const arr = repliesMap.get(c.parentId) || []
    arr.push(c)
    repliesMap.set(c.parentId, arr)
  })

  async function handleReply(parentId: string) {
    if (!replyText.trim()) return
    setSaving(true)
    await addReply(leadId, parentId, replyText.trim())
    setReplyText('')
    setReplyingTo(null)
    setSaving(false)
    onReplyAdded()
  }

  return (
    <div className="space-y-3">
      {topLevel.map((comment: any) => (
        <div key={comment.id} className="space-y-2">
          {/* Main comment */}
          <div className="rounded-md bg-muted/50 p-3">
            <div className="flex items-center gap-2 mb-1">
              <div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                {(comment.authorName ?? '?')[0]?.toUpperCase()}
              </div>
              <span className="text-xs font-medium">{comment.authorName}</span>
              <span className="text-xs text-muted-foreground">
                {new Date(comment.createdAt).toLocaleString()}
              </span>
            </div>
            <p className="text-sm">{comment.content}</p>
            <button
              onClick={() => setReplyingTo(replyingTo === comment.id ? null : comment.id)}
              className="mt-1 text-xs text-primary hover:underline"
            >
              Reply
            </button>
          </div>

          {/* Replies */}
          {repliesMap.get(comment.id)?.map((reply: any) => (
            <div key={reply.id} className="ml-8 rounded-md bg-muted/30 p-3">
              <div className="flex items-center gap-2 mb-1">
                <div className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold text-primary">
                  {(reply.authorName ?? '?')[0]?.toUpperCase()}
                </div>
                <span className="text-xs font-medium">{reply.authorName}</span>
                <span className="text-xs text-muted-foreground">
                  {new Date(reply.createdAt).toLocaleString()}
                </span>
              </div>
              <p className="text-sm">{reply.content}</p>
            </div>
          ))}

          {/* Reply form */}
          {replyingTo === comment.id && (
            <div className="ml-8 flex gap-2">
              <input
                type="text"
                value={replyText}
                onChange={e => setReplyText(e.target.value)}
                placeholder="Write a reply..."
                className="h-8 flex-1 rounded-md border bg-background px-3 text-sm"
                onKeyDown={e => e.key === 'Enter' && handleReply(comment.id)}
              />
              <Button size="sm" onClick={() => handleReply(comment.id)} disabled={!replyText.trim() || saving}>
                {saving ? '...' : 'Reply'}
              </Button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function InfoRow({ label, value, link }: { label: string; value: string | null; link?: boolean }) {
  if (!value) return null
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      {link ? (
        <a
          href={value.startsWith('http') ? value : `https://${value}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-primary hover:underline"
        >
          {value}
        </a>
      ) : (
        <p className="text-sm">{value}</p>
      )}
    </div>
  )
}
