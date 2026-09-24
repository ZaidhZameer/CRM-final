'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Mail, Link2, Unplug, CheckCircle2, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getMailboxStatus, disconnectMailbox, type MailboxStatus } from './mailbox-actions'

const CALLBACK_MESSAGES: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: 'Mailbox connected. Approved follow-ups will be sent from it.' },
  cancelled: { ok: false, text: 'Connection cancelled. Nothing was changed.' },
  missing_permission: { ok: false, text: 'Google did not grant permission to send email. Please try again and allow sending.' },
  forbidden: { ok: false, text: 'Only workspace owners and admins can connect the mailbox.' },
  not_configured: { ok: false, text: 'Google sign-in is not set up on this server yet.' },
  error: { ok: false, text: 'Could not connect the mailbox. Please try again.' },
}

export function MailboxSettings() {
  const params = useSearchParams()
  const [status, setStatus] = useState<MailboxStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const callback = CALLBACK_MESSAGES[params.get('gmail') ?? '']

  useEffect(() => {
    let active = true
    getMailboxStatus().then((s) => { if (active) setStatus(s) }).catch(() => {})
    return () => { active = false }
  }, [])

  async function handleDisconnect() {
    setBusy(true)
    setError(null)
    const res = await disconnectMailbox()
    if (res.error) setError(res.error)
    else setStatus((s) => (s ? { ...s, connected: false, email: null, status: null, canReadReplies: false } : s))
    setBusy(false)
  }

  return (
    <div className="rounded-xl border bg-card p-6 space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
          <Mail className="size-[18px] text-primary" />
        </div>
        <div>
          <h2 className="text-base font-semibold">Follow-up mailbox</h2>
          <p className="text-xs text-muted-foreground">
            Approved follow-ups are sent from this Google Workspace mailbox, and replies are picked up automatically.
            Plain text, no tracking pixels.
          </p>
        </div>
      </div>

      {callback && (
        <div className={`rounded-lg border px-3 py-2 text-sm ${callback.ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600' : 'border-destructive/30 bg-destructive/10 text-destructive'}`}>
          {callback.text}
        </div>
      )}
      {error && <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}

      <div className="rounded-lg border bg-muted/20 p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">Gmail / Google Workspace</p>
            {!status ? (
              <p className="text-xs text-muted-foreground">Checking…</p>
            ) : status.connected ? (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <CheckCircle2 className="size-3.5 text-emerald-500" />
                <span className="truncate">Connected as {status.email}</span>
                {!status.canReadReplies && <span className="text-amber-500">(replies not readable, so reconnect and allow reading)</span>}
              </p>
            ) : status.status === 'error' ? (
              <p className="flex items-center gap-1.5 text-xs text-destructive">
                <AlertTriangle className="size-3.5" /> Access to {status.email} stopped working. Reconnect to resume sending.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">Not connected. Follow-ups are drafted for approval but not sent.</p>
            )}
          </div>

          {status?.canManage && (
            status.connected ? (
              <Button variant="outline" size="sm" onClick={handleDisconnect} disabled={busy} className="gap-1.5 text-xs">
                <Unplug className="h-3.5 w-3.5" /> Disconnect
              </Button>
            ) : status.configured ? (
              <a href="/api/auth/gmail/connect">
                <Button size="sm" className="gap-1.5 text-xs">
                  <Link2 className="h-3.5 w-3.5" /> {status.status === 'error' ? 'Reconnect' : 'Connect Gmail'}
                </Button>
              </a>
            ) : (
              <span className="text-xs text-muted-foreground">Google sign-in not configured</span>
            )
          )}
        </div>
      </div>
    </div>
  )
}
