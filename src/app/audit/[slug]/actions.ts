'use server'

import { headers } from 'next/headers'
import { createServiceClient } from '@/lib/supabase/service'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { auditWebsite } from '@/lib/sourcing/site-audit'

export type PublicAuditResult =
  | { ok: true; website: string; findings: { severity: 'high' | 'medium' | 'low'; message: string }[] }
  | { ok: false; error: string }

/**
 * Free website check for visitors. Only works for an active lead form's id (the page passes it),
 * is rate limited per form and per visitor, and returns our own fixed sentences only: nothing
 * from the audited page is echoed back.
 */
export async function runPublicAudit(formId: string, rawUrl: string): Promise<PublicAuditResult> {
  const h = await headers()
  const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  const [byForm, byIp] = await Promise.all([RATE_LIMITS.form(`audit:${formId}`), RATE_LIMITS.form(`audit-ip:${ip}`)])
  if (!byForm.success || !byIp.success) return { ok: false, error: 'Too many checks right now. Please try again in a minute.' }

  const url = String(rawUrl ?? '').trim().slice(0, 300)
  if (!url) return { ok: false, error: 'Please enter your website address.' }

  const service = createServiceClient()
  const { data: form } = await service.from('lead_forms').select('id, is_active').eq('id', formId).maybeSingle()
  if (!form?.is_active) return { ok: false, error: 'This page is not available.' }

  const res = await auditWebsite(/^https?:\/\//i.test(url) ? url : `https://${url}`)
  if (!res.ok) return { ok: false, error: "We couldn't reach that website. Check the address and try again." }
  return {
    ok: true,
    website: new URL(res.signals.finalUrl).origin,
    findings: res.findings.slice(0, 3).map((f) => ({ severity: f.severity, message: f.message })),
  }
}
