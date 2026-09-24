'use client'

import { useState, useEffect } from 'react'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { getJobs, type JobRow } from './actions'
import { Circle, Clock, CheckCircle2, XCircle, AlertCircle, PlayCircle, Loader2 } from 'lucide-react'

type BadgeTone = React.ComponentProps<typeof Badge>['tone']

const STATUS_ICONS: Record<string, React.ElementType> = {
  queued: Clock,
  running: PlayCircle,
  awaiting_approval: Loader2,
  done: CheckCircle2,
  failed: XCircle,
  cancelled: AlertCircle,
}

const STATUS_COLORS: Record<string, BadgeTone> = {
  queued: 'neutral',
  running: 'blue',
  awaiting_approval: 'amber',
  done: 'emerald',
  failed: 'red',
  cancelled: 'neutral',
}

// Full class names so Tailwind can see them; `text-${tone}-500` is never generated.
const ICON_COLORS: Record<string, string> = {
  queued: 'text-muted-foreground',
  running: 'text-blue-500',
  awaiting_approval: 'text-amber-500',
  done: 'text-emerald-500',
  failed: 'text-red-500',
  cancelled: 'text-muted-foreground',
}

const STATUS_OPTIONS = ['queued', 'running', 'awaiting_approval', 'done', 'failed', 'cancelled']

export default function JobsPage() {
  const [jobs, setJobs] = useState<JobRow[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    let active = true
    async function load() {
      setLoading(true)
      const result = await getJobs({ status: filter || undefined })
      if (active) {
        setJobs(result.jobs)
        setLoading(false)
      }
    }
    load()
    return () => { active = false }
  }, [filter])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Jobs</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {jobs.length} recent jobs
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        {['', ...STATUS_OPTIONS].map(s => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`rounded-lg px-3.5 py-1.5 text-xs font-medium capitalize transition-all duration-150 ${
              filter === s
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'
            }`}
          >
            {(s || 'All').replace('_', ' ')}
          </button>
        ))}
      </div>

      {/* Job list */}
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} className="flex items-center gap-3 p-4">
              <Skeleton className="h-5 w-5 shrink-0 rounded-full" />
              <Skeleton className="h-4 w-48" />
              <Skeleton className="ml-auto h-5 w-14 rounded-full" />
              <Skeleton className="h-7 w-24 rounded-lg" />
            </Card>
          ))}
        </div>
      ) : jobs.length === 0 ? (
        <div className="rounded-xl border bg-card p-12 text-center">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-muted">
            <CheckCircle2 className="size-5 text-muted-foreground" />
          </div>
          <p className="mt-3 text-sm text-muted-foreground">No jobs found.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {jobs.map(job => {
            const StatusIcon = STATUS_ICONS[job.status] ?? Circle
            return (
              <div
                key={job.id}
                className="flex flex-col gap-2 rounded-xl border bg-card p-4 transition-all duration-150 hover:shadow-sm sm:flex-row sm:items-center sm:gap-3"
              >
                <div className="flex items-start gap-3 min-w-0 flex-1">
                  <StatusIcon className={`mt-0.5 size-5 shrink-0 ${ICON_COLORS[job.status] ?? 'text-muted-foreground'}`} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      {job.job_type}
                    </p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {job.subject_type && (
                        <span>Subject: {job.subject_type}</span>
                      )}
                      <span>Created: {new Date(job.created_at).toLocaleString()}</span>
                      {job.finished_at && (
                        <span>Finished: {new Date(job.finished_at).toLocaleString()}</span>
                      )}
                      {job.attempts > 0 && (
                        <span>Attempts: {job.attempts}</span>
                      )}
                    </div>
                    {job.status === 'failed' && job.error_message && (
                      <p className="mt-1.5 text-xs text-destructive bg-destructive/10 p-2 rounded-md">
                        {job.error_message}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 sm:ml-auto">
                  <Badge tone={STATUS_COLORS[job.status]} className="capitalize">
                    {job.status.replace('_', ' ')}
                  </Badge>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
