'use client'

import { useState, useRef, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { Search, Bell, LogOut, ChevronRight, User, Menu, ShieldCheck, AlertTriangle } from 'lucide-react'
import { ThemeToggle } from '@/components/theme/theme-toggle'
import { OPEN_COMMAND_PALETTE_EVENT } from '@/components/layout/command-palette'
import { getAttentionCounts, type AttentionCounts } from '@/actions/attention'

type Org = { id: string; name: string; slug: string; role: string }
type Profile = { id: string; fullName: string | null; avatarUrl: string | null }

const BREADCRUMB_LABELS: Record<string, string> = {
  dashboard: 'Dashboard',
  leads: 'Leads',
  pipeline: 'Pipeline',
  deals: 'Deals',
  tasks: 'Tasks',
  calendar: 'Calendar',
  projects: 'Projects',
  'lead-forms': 'Lead Forms',
  import: 'Import',
  settings: 'Settings',
  tables: 'Tables',
  trash: 'Trash',
  approvals: 'Approvals',
  jobs: 'Jobs',
  onboarding: 'Onboarding',
}

export function TopBar({
  profile,
  orgs,
  activeOrgId,
  onMenuClick,
}: {
  profile: Profile
  orgs: Org[]
  activeOrgId: string
  onMenuClick?: () => void
}) {
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [notifOpen, setNotifOpen] = useState(false)
  const [attention, setAttention] = useState<AttentionCounts>({ pendingApprovals: 0, failedJobs24h: 0 })
  const attentionTotal = attention.pendingApprovals + attention.failedJobs24h

  const menuRef = useRef<HTMLDivElement>(null)
  const notifRef = useRef<HTMLDivElement>(null)
  const router = useRouter()
  const pathname = usePathname()
  // Refresh on navigation and every minute, so the badge follows decisions made elsewhere.
  useEffect(() => {
    let active = true
    const load = () =>
      getAttentionCounts()
        .then((c) => { if (active) setAttention(c) })
        .catch(() => {})
    load()
    const timer = setInterval(load, 60_000)
    return () => { active = false; clearInterval(timer) }
  }, [pathname])
  const supabase = createClient()

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false)
      }
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setNotifOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const segments = pathname.split('/').filter(Boolean)
  const breadcrumbs = segments
    .map((seg) => ({ label: BREADCRUMB_LABELS[seg] || seg, href: '/' + seg }))
    .slice(0, 2)

  const initials = profile.fullName
    ? profile.fullName
        .split(' ')
        .map((n) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : '?'

  async function handleSignOut() {
    await supabase.auth.signOut()
    window.location.href = '/sign-in'
  }

  return (
    <header className="relative z-30 flex h-14 shrink-0 items-center justify-between border-b bg-card/80 px-5 backdrop-blur-sm">
      {/* Mobile menu button */}
      <button
        onClick={onMenuClick}
        aria-label="Open navigation"
        className="-ml-1 mr-1 flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden"
      >
        <Menu className="size-5" />
      </button>

      {/* Breadcrumbs */}
      <nav className="flex flex-1 items-center gap-1 text-sm">
        {breadcrumbs.map((crumb, i) => (
          <div key={crumb.href} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="size-3.5 text-muted-foreground/50" />}
            {i < breadcrumbs.length - 1 ? (
              <Link
                href={crumb.href}
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                {crumb.label}
              </Link>
            ) : (
              <span className="font-medium text-foreground">
                {crumb.label}
              </span>
            )}
          </div>
        ))}
      </nav>

      {/* Right side */}
      <div className="flex items-center gap-2">
        {/* Quick search */}
        <button
          onClick={() => window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT))}
          className="flex h-8 items-center gap-2 rounded-lg border bg-muted/50 px-3 text-sm text-muted-foreground transition-colors hover:bg-muted"
        >
          <Search className="size-3.5" />
          <span className="hidden sm:inline">Search</span>
          <kbd className="ml-2 hidden rounded bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/60 sm:inline">
            Ctrl K
          </kbd>
        </button>

        {/* Theme toggle */}
        <ThemeToggle />

        {/* Notifications */}
        <div className="relative" ref={notifRef}>
          <button
            onClick={() => setNotifOpen((o) => !o)}
            aria-label="Notifications"
            aria-haspopup="menu"
            aria-expanded={notifOpen}
            className="relative flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Bell className="size-4" />
            {attentionTotal > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-white">
                {attentionTotal > 9 ? '9+' : attentionTotal}
              </span>
            )}
          </button>

          {notifOpen && (
            <div className="absolute right-0 top-full z-50 mt-2 w-72 rounded-xl border bg-popover p-1.5 shadow-xl">
              <div className="border-b px-3 py-2.5">
                <p className="text-sm font-medium">Notifications</p>
              </div>
              {attentionTotal === 0 ? (
                <div className="flex flex-col items-center gap-1.5 px-3 py-8 text-center">
                  <Bell className="size-6 text-muted-foreground/40" />
                  <p className="text-sm font-medium">You&apos;re all caught up</p>
                  <p className="text-xs text-muted-foreground">No new notifications right now.</p>
                </div>
              ) : (
                <div className="flex flex-col py-1">
                  {attention.pendingApprovals > 0 && (
                    <Link
                      href="/approvals"
                      onClick={() => setNotifOpen(false)}
                      className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-muted"
                    >
                      <ShieldCheck className="size-4 text-amber-500" />
                      {attention.pendingApprovals} approval{attention.pendingApprovals === 1 ? '' : 's'} waiting for you
                    </Link>
                  )}
                  {attention.failedJobs24h > 0 && (
                    <Link
                      href="/jobs"
                      onClick={() => setNotifOpen(false)}
                      className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-muted"
                    >
                      <AlertTriangle className="size-4 text-destructive" />
                      {attention.failedJobs24h} automation job{attention.failedJobs24h === 1 ? '' : 's'} failed in the last 24h
                    </Link>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* User menu */}
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setUserMenuOpen(!userMenuOpen)}
            className="flex items-center gap-2 rounded-lg p-1 transition-colors hover:bg-muted"
          >
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground">
              {initials}
            </div>
          </button>

          {userMenuOpen && (
            <div className="absolute right-0 top-full z-50 mt-2 w-56 rounded-xl border bg-popover p-1.5 shadow-xl">
              <div className="border-b px-3 py-2.5">
                <p className="text-sm font-medium">{profile.fullName}</p>
                <p className="text-xs text-muted-foreground">
                  {orgs.find((o) => o.id === activeOrgId)?.name}
                </p>
              </div>
              <div className="py-1">
                <button
                  onClick={() => { setUserMenuOpen(false); router.push('/settings') }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <User className="size-4" />
                  Profile & Settings
                </button>
                <button
                  onClick={handleSignOut}
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-destructive transition-colors hover:bg-destructive/10"
                >
                  <LogOut className="size-4" />
                  Sign out
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
