'use client'

import { useState, useEffect, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { getOrgSettings, updateOrgName, updateProfile } from './actions'
import Link from 'next/link'
import { User, Building2, Users, ChevronRight, FileText, Shield, Trash2, ScrollText } from 'lucide-react'
import { BookingSettings } from './booking-settings'
import { MailboxSettings } from './mailbox-settings'

const ROLE_STYLES: Record<string, string> = {
  owner: 'bg-purple-50 text-purple-600 ring-purple-500/20 dark:bg-purple-950/40 dark:text-purple-400',
  admin: 'bg-blue-50 text-blue-600 ring-blue-500/20 dark:bg-blue-950/40 dark:text-blue-400',
  sales: 'bg-emerald-50 text-emerald-600 ring-emerald-500/20 dark:bg-emerald-950/40 dark:text-emerald-400',
  viewer: 'bg-gray-50 text-gray-600 ring-gray-500/20 dark:bg-gray-800 dark:text-gray-400',
}

const LINKS = [
  { href: '/settings/audit-log', label: 'Audit Log', desc: 'View all activity and changes', icon: ScrollText },
  { href: '/projects', label: 'Projects', desc: 'Manage client projects from won deals', icon: Building2 },
  { href: '/trash', label: 'Trash', desc: 'Restore or permanently remove deleted leads', icon: Trash2 },
  { href: '/settings/backups', label: 'Backups & Security', desc: 'Data protection and security overview', icon: Shield },
  { href: '/privacy', label: 'Privacy Policy', desc: 'How we handle your data', icon: FileText },
  { href: '/terms', label: 'Terms of Service', desc: 'Usage terms and conditions', icon: FileText },
]

export default function SettingsPage() {
  const searchParams = useSearchParams()
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [orgName, setOrgName] = useState('')
  const [profileName, setProfileName] = useState('')
  const [saving, setSaving] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  useEffect(() => {
    const gcal = searchParams.get('gcal')
    if (gcal === 'connected') {
      setSuccess('Google Calendar connected successfully!')
      setTimeout(() => setSuccess(null), 4000)
    } else if (gcal === 'error') {
      setSuccess(null)
    }
  }, [searchParams])

  useEffect(() => {
    async function load() {
      const result = await getOrgSettings()
      if ('error' in result) return
      setData(result)
      setOrgName(result.org?.name ?? '')
      setProfileName(result.profile?.fullName ?? '')
      setLoading(false)
    }
    load()
  }, [])

  async function handleSaveOrg() {
    setSaving('org')
    await updateOrgName(orgName)
    setSaving(null)
    setSuccess('Organization name updated')
    setTimeout(() => setSuccess(null), 3000)
  }

  async function handleSaveProfile() {
    setSaving('profile')
    await updateProfile(profileName)
    setSaving(null)
    setSuccess('Profile updated')
    setTimeout(() => setSuccess(null), 3000)
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-primary/30 border-t-primary" />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">Manage your organization and profile</p>
      </div>

      {success && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-400">
          {success}
        </div>
      )}

      {/* Profile */}
      <div className="rounded-xl border bg-card p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
            <User className="size-[18px] text-primary" />
          </div>
          <h2 className="text-base font-semibold">Profile</h2>
        </div>
        <div className="space-y-2">
          <label htmlFor="profile-name" className="text-sm font-medium text-muted-foreground">Full Name</label>
          <div className="flex gap-3">
            <input
              id="profile-name"
              type="text"
              value={profileName}
              onChange={e => setProfileName(e.target.value)}
              className="h-9 flex-1 rounded-lg border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring/30"
            />
            <Button onClick={handleSaveProfile} disabled={saving === 'profile'}>
              {saving === 'profile' ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </div>
      </div>

      {/* Organization */}
      <div className="rounded-xl border bg-card p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
              <Building2 className="size-[18px] text-primary" />
            </div>
            <h2 className="text-base font-semibold">Organization</h2>
          </div>
          {data?.org?.plan && (
            <span className="badge bg-primary/10 text-primary ring-primary/20 capitalize">
              {data.org.plan} plan
            </span>
          )}
        </div>
        <div className="space-y-2">
          <label htmlFor="org-name" className="text-sm font-medium text-muted-foreground">Organization Name</label>
          <div className="flex gap-3">
            <input
              id="org-name"
              type="text"
              value={orgName}
              onChange={e => setOrgName(e.target.value)}
              className="h-9 flex-1 rounded-lg border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring/30"
            />
            <Button onClick={handleSaveOrg} disabled={saving === 'org'}>
              {saving === 'org' ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4 rounded-lg bg-muted/30 p-4 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">Slug</p>
            <p className="mt-0.5 font-mono text-sm">{data?.org?.slug}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">AI Daily Cap</p>
            <p className="mt-0.5 text-sm">${((data?.org?.ai_daily_cap_cents ?? 0) / 100).toFixed(2)}</p>
          </div>
        </div>
      </div>

      {/* Booking Page */}
      <BookingSettings />

      {/* Follow-up mailbox (Gmail) */}
      <Suspense fallback={null}>
        <MailboxSettings />
      </Suspense>

      {/* Team Members */}
      <div className="rounded-xl border bg-card p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
            <Users className="size-[18px] text-primary" />
          </div>
          <h2 className="text-base font-semibold">Team Members</h2>
        </div>
        {data?.members?.length === 0 ? (
          <p className="text-sm text-muted-foreground">No team members yet.</p>
        ) : (
          <div className="space-y-2">
            {data?.members?.map((m: any) => (
              <div key={m.id} className="flex items-center justify-between rounded-lg border p-3 transition-colors hover:bg-muted/20">
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                    {(m.fullName ?? '?')[0]?.toUpperCase()}
                  </div>
                  <p className="text-sm font-medium">{m.fullName}</p>
                </div>
                <span className={`badge capitalize ${ROLE_STYLES[m.role] ?? ''}`}>
                  {m.role}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Quick Links */}
      <div className="rounded-xl border bg-card p-6 space-y-4">
        <h2 className="text-base font-semibold">More</h2>
        <div className="flex flex-col gap-1.5">
          {LINKS.map(link => {
            const Icon = link.icon
            return (
              <Link
                key={link.href}
                href={link.href}
                className="flex items-center gap-3 rounded-lg border p-3.5 transition-all duration-150 hover:bg-muted/30 hover:shadow-sm"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <Icon className="size-4 text-muted-foreground" />
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium">{link.label}</p>
                  <p className="text-xs text-muted-foreground">{link.desc}</p>
                </div>
                <ChevronRight className="size-4 text-muted-foreground/40" />
              </Link>
            )
          })}
        </div>
      </div>
    </div>
  )
}
