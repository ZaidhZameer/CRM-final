'use client'

import { useEffect, useState } from 'react'
import { Briefcase } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  AGENCY_PROFILE_LABELS,
  AGENCY_PROFILE_LIMITS,
  EMPTY_AGENCY_PROFILE,
  type AgencyProfileField,
  type AgencyProfileFields,
} from '@/lib/agency-profile'
import { getAgencyProfile, saveAgencyProfile } from './agency-profile-actions'

const FIELDS: { key: AgencyProfileField; hint: string; rows: number }[] = [
  { key: 'services', hint: 'e.g. Websites for trades businesses, AI booking assistants, monthly SEO', rows: 4 },
  { key: 'audience', hint: 'e.g. Owner-run local service businesses with 2 to 20 staff', rows: 3 },
  { key: 'brand_voice', hint: 'e.g. Plain, friendly, direct. No jargon, no hype.', rows: 3 },
  { key: 'competitors', hint: 'e.g. Wix and Squarespace DIY, big agencies charging 10k+', rows: 3 },
  { key: 'past_work', hint: 'e.g. Rebuilt a plumber site; enquiries up 40% in 3 months', rows: 4 },
  { key: 'do_rules', hint: 'e.g. Mention the free site audit. Offer a fixed price.', rows: 3 },
  { key: 'dont_rules', hint: 'e.g. Never promise rankings. Never mention competitors by name.', rows: 3 },
]

export function AgencyProfileSettings() {
  const [fields, setFields] = useState<AgencyProfileFields>({ ...EMPTY_AGENCY_PROFILE })
  const [version, setVersion] = useState<number | null>(null)
  const [canManage, setCanManage] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    getAgencyProfile()
      .then((p) => {
        if (!active) return
        setFields(p.fields)
        setVersion(p.version)
        setCanManage(p.canManage)
        setLoaded(true)
      })
      .catch(() => { if (active) setError('Could not load the agency profile.') })
    return () => { active = false }
  }, [])

  async function handleSave() {
    setBusy(true)
    setError(null)
    setSaved(null)
    const res = await saveAgencyProfile(fields, version)
    if (res.error) setError(res.error)
    else {
      setVersion(res.version ?? version)
      setSaved('Saved. New proposals and follow-ups will use this.')
    }
    setBusy(false)
  }

  return (
    <div className="rounded-xl border bg-card p-6 space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
          <Briefcase className="size-[18px] text-primary" />
        </div>
        <div>
          <h2 className="text-base font-semibold">Agency profile</h2>
          <p className="text-xs text-muted-foreground">
            Used by the AI when it drafts proposals and follow-ups. Be specific: what you sell, who for, how you sound, and anything it must never say.
          </p>
        </div>
      </div>

      {error && <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}

      {!loaded && !error ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : (
        <div className="space-y-4">
          {FIELDS.map(({ key, hint, rows }) => (
            <div key={key}>
              <label htmlFor={`agency-${key}`} className="mb-1.5 block text-sm font-medium text-muted-foreground">
                {AGENCY_PROFILE_LABELS[key]}
              </label>
              <textarea
                id={`agency-${key}`}
                rows={rows}
                maxLength={AGENCY_PROFILE_LIMITS[key]}
                placeholder={hint}
                className="w-full rounded-md border bg-background p-3 text-sm leading-relaxed"
                value={fields[key]}
                disabled={!canManage || busy}
                onChange={(e) => setFields({ ...fields, [key]: e.target.value })}
              />
              <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
            </div>
          ))}
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {canManage ? saved ?? 'Plain text only.' : 'Only owners and admins can edit the agency profile.'}
            </p>
            <Button size="sm" className="text-xs" disabled={!canManage || busy || !loaded} onClick={handleSave}>
              {busy ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
