'use client'

import { useState } from 'react'
import { submitPublicForm } from '@/app/f/[slug]/actions'
import { runPublicAudit, type PublicAuditResult } from './actions'

const input = 'h-10 w-full rounded-md border bg-background px-3 text-sm'
const TONE = { high: 'text-red-600', medium: 'text-amber-600', low: 'text-muted-foreground' } as const

export function AuditFlow({ formId, orgId }: { formId: string; orgId: string }) {
  const [url, setUrl] = useState('')
  const [audit, setAudit] = useState<Extract<PublicAuditResult, { ok: true }> | null>(null)
  const [contact, setContact] = useState({ contact_name: '', email: '', company_name: '' })
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function check(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    const res = await runPublicAudit(formId, url)
    setBusy(false)
    if (res.ok) setAudit(res)
    else setError(res.error)
  }

  async function send(e: React.FormEvent) {
    e.preventDefault()
    if (!audit) return
    setBusy(true); setError(null)
    const summary = audit.findings.map((f) => `- ${f.message}`).join('\n')
    const res = await submitPublicForm(formId, orgId, {
      ...contact,
      website: audit.website,
      message: `Asked for a free website check.\n${summary || 'No issues found.'}`,
    })
    setBusy(false)
    if (res.error) setError(res.error)
    else setDone(true)
  }

  if (done) return <p className="text-center text-sm">Thanks. We will be in touch about your website shortly.</p>

  return (
    <div className="space-y-5">
      <form onSubmit={check} className="flex gap-2">
        <input className={input} placeholder="yourbusiness.co.uk" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Your website" required />
        <button className="h-10 shrink-0 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-60" disabled={busy}>
          {busy && !audit ? 'Checking…' : 'Check'}
        </button>
      </form>

      {audit && (
        <>
          <div className="rounded-lg border p-4">
            <p className="mb-2 text-sm font-medium">What we found on {audit.website.replace(/^https?:\/\//, '')}</p>
            {audit.findings.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing obvious stood out. Nice work.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {audit.findings.map((f, i) => <li key={i} className={TONE[f.severity]}>{f.message}</li>)}
              </ul>
            )}
          </div>
          <form onSubmit={send} className="space-y-3">
            <p className="text-sm font-medium">Want help fixing it? Leave your details and we will get back to you.</p>
            <input className={input} placeholder="Your name" value={contact.contact_name} onChange={(e) => setContact({ ...contact, contact_name: e.target.value })} required />
            <input className={input} type="email" placeholder="Email" value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} required />
            <input className={input} placeholder="Business name (optional)" value={contact.company_name} onChange={(e) => setContact({ ...contact, company_name: e.target.value })} />
            <p className="text-xs text-muted-foreground">We will use these details only to reply to you about your website. See our <a className="underline" href="/privacy">privacy notice</a>.</p>
            <button className="h-10 w-full rounded-md bg-primary text-sm font-medium text-primary-foreground disabled:opacity-60" disabled={busy}>{busy ? 'Sending…' : 'Send my details'}</button>
          </form>
        </>
      )}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </div>
  )
}
