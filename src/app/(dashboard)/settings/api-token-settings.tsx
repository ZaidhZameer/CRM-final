'use client'

import { useEffect, useState } from 'react'
import { Bot, Copy, KeyRound, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { listApiTokens, createApiToken, revokeApiToken, type AgentsOverview } from './api-token-actions'

function fmt(iso: string | null) {
  return iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null
}

export function ApiTokenSettings() {
  const [data, setData] = useState<AgentsOverview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [canPropose, setCanPropose] = useState(true)
  const [expiry, setExpiry] = useState('90')
  const [created, setCreated] = useState<{ token: string; name: string } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  async function refresh() {
    setData(await listApiTokens())
  }
  useEffect(() => {
    let active = true
    listApiTokens().then((d) => { if (active) setData(d) }).catch(() => {})
    return () => { active = false }
  }, [])

  const endpoint = data?.endpoint || `${typeof window === 'undefined' ? '' : window.location.origin}/api/mcp`

  async function handleCreate() {
    setBusy(true)
    setError(null)
    const res = await createApiToken({
      name,
      scopes: canPropose ? ['read', 'propose'] : ['read'],
      expiresInDays: expiry === 'never' ? null : Number(expiry),
    })
    if (res.error || !res.token) setError(res.error ?? 'Could not create the connection.')
    else {
      setCreated({ token: res.token, name: name.trim() })
      setName('')
      await refresh()
    }
    setBusy(false)
  }

  async function handleRevoke(id: string) {
    if (!window.confirm('Revoke this connection? The agent loses access immediately.')) return
    setBusy(true)
    setError(null)
    const res = await revokeApiToken(id)
    if (res.error) setError(res.error)
    await refresh()
    setBusy(false)
  }

  async function copy(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(label)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      setError('Copy failed. Select the text and copy it manually.')
    }
  }

  const cliCommand = created ? `claude mcp add --transport http flowlead ${endpoint} --header "Authorization: Bearer ${created.token}"` : ''
  const active = (data?.tokens ?? []).filter((t) => !t.revokedAt)
  const revoked = (data?.tokens ?? []).filter((t) => t.revokedAt)

  return (
    <div className="rounded-xl border bg-card p-6 space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
          <Bot className="size-[18px] text-primary" />
        </div>
        <div>
          <h2 className="text-base font-semibold">Connected agents</h2>
          <p className="text-xs text-muted-foreground">
            Let Claude, ChatGPT or Hermes read your pipeline and propose drafts. Agents can never send, approve, price, change consent
            or delete: everything they propose lands in the Approval Inbox for you.
          </p>
        </div>
      </div>

      {error && <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}

      {created && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 space-y-3">
          <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
            &ldquo;{created.name}&rdquo; created. Copy the token now: it is shown once and cannot be recovered.
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border bg-background px-3 py-2 text-xs">{created.token}</code>
            <Button size="sm" variant="outline" className="gap-1.5 text-xs" onClick={() => copy('token', created.token)}>
              <Copy className="h-3.5 w-3.5" /> {copied === 'token' ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <div className="space-y-2 text-xs text-muted-foreground">
            <p><span className="font-medium text-foreground">URL:</span> <code>{endpoint}</code></p>
            <p><span className="font-medium text-foreground">Header:</span> <code>Authorization: Bearer &lt;token&gt;</code></p>
            <p className="font-medium text-foreground">Claude Code</p>
            <div className="flex items-start gap-2">
              <code className="min-w-0 flex-1 break-all rounded-md border bg-background px-3 py-2">{cliCommand}</code>
              <Button size="sm" variant="outline" className="gap-1.5 text-xs" onClick={() => copy('cli', cliCommand)}>
                <Copy className="h-3.5 w-3.5" /> {copied === 'cli' ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <p>
              <span className="font-medium text-foreground">Claude Desktop / ChatGPT / Hermes:</span> add a custom MCP server (HTTP / streamable),
              paste the URL above, and set the header <code>Authorization</code> to <code>Bearer</code> followed by the token.
            </p>
          </div>
          <Button size="sm" variant="outline" className="text-xs" onClick={() => setCreated(null)}>I&apos;ve saved it</Button>
        </div>
      )}

      {data?.canManage && (
        <div className="rounded-lg border bg-muted/20 p-4 space-y-3">
          <p className="text-sm font-medium">New connection</p>
          <div className="flex flex-wrap items-center gap-3">
            <input
              aria-label="Connection name"
              className="h-9 min-w-[12rem] flex-1 rounded-md border bg-background px-3 text-sm"
              placeholder="e.g. Claude Desktop, Hermes on VPS"
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <select
              aria-label="Expiry"
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
            >
              <option value="30">Expires in 30 days</option>
              <option value="90">Expires in 90 days</option>
              <option value="365">Expires in 1 year</option>
              <option value="never">No expiry</option>
            </select>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" className="size-4 accent-primary" checked={canPropose} onChange={(e) => setCanPropose(e.target.checked)} />
            Allow proposing drafts, notes and tasks (otherwise read-only)
          </label>
          <Button size="sm" className="gap-1.5 text-xs" disabled={busy || !name.trim()} onClick={handleCreate}>
            <KeyRound className="h-3.5 w-3.5" /> Create connection
          </Button>
        </div>
      )}

      {!data ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : active.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {data.canManage ? 'No agents connected yet.' : 'You have no connected agents. Ask an owner or admin to create one.'}
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {active.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{t.name}</p>
                <p className="text-xs text-muted-foreground">
                  {t.scopes.includes('propose') ? 'Read + propose' : 'Read only'}
                  {data.canManage && !t.mine && t.ownerName ? ` · ${t.ownerName}` : ''}
                  {' · '}created {fmt(t.createdAt)}
                  {' · '}{t.lastUsedAt ? `last used ${fmt(t.lastUsedAt)}` : 'never used'}
                  {t.expiresAt ? ` · expires ${fmt(t.expiresAt)}` : ''}
                </p>
              </div>
              {data.canManage && (
                <Button variant="outline" size="sm" className="gap-1.5 text-xs" disabled={busy} onClick={() => handleRevoke(t.id)}>
                  <Trash2 className="h-3.5 w-3.5" /> Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {revoked.length > 0 && <p className="text-xs text-muted-foreground">{revoked.length} revoked connection{revoked.length === 1 ? '' : 's'} not shown.</p>}
    </div>
  )
}
