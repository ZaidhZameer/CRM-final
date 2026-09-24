'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { setActiveOrg } from '@/actions/org'
import { useToast } from '@/components/ui/toast'
import { OPEN_COMMAND_PALETTE_EVENT } from '@/components/layout/command-palette'
import {
  LayoutDashboard,
  Users,
  Kanban,
  Handshake,
  CheckSquare,
  Calendar,
  FolderKanban,
  FileInput,
  Upload,
  Table2,
  Settings,
  ChevronDown,
  Sparkles,
  Search,
  X,
  ShieldCheck,
  Activity,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

type Org = { id: string; name: string; slug: string; role: string }

const MAIN_NAV = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Leads', href: '/leads', icon: Users },
  { label: 'Pipeline', href: '/pipeline', icon: Kanban },
  { label: 'Deals', href: '/deals', icon: Handshake },
]

const MANAGE_NAV = [
  { label: 'Tasks', href: '/tasks', icon: CheckSquare },
  { label: 'Approvals', href: '/approvals', icon: ShieldCheck },
  { label: 'Jobs', href: '/jobs', icon: Activity },
  { label: 'Calendar', href: '/calendar', icon: Calendar },
  { label: 'Projects', href: '/projects', icon: FolderKanban },
]

const DATA_NAV = [
  { label: 'Lead Forms', href: '/lead-forms', icon: FileInput },
  { label: 'Import', href: '/import', icon: Upload },
  { label: 'Tables', href: '/tables', icon: Table2 },
]

function NavSection({
  label,
  items,
  pathname,
  onNavigate,
}: {
  label: string
  items: typeof MAIN_NAV
  pathname: string
  onNavigate?: () => void
}) {
  return (
    <div className="space-y-0.5">
      <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-widest text-sidebar-foreground/40">
        {label}
      </p>
      {items.map((item) => {
        const isActive = pathname === item.href || pathname.startsWith(item.href + '/')
        const Icon = item.icon
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={isActive ? 'page' : undefined}
            className={`group flex h-8 items-center gap-2.5 rounded-lg px-3 text-[13px] font-medium transition-all duration-150 ${
              isActive
                ? 'bg-sidebar-accent text-sidebar-accent-foreground shadow-sm'
                : 'text-sidebar-foreground/60 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
            }`}
          >
            <Icon className={`size-4 shrink-0 transition-colors ${isActive ? 'text-sidebar-primary' : 'text-sidebar-foreground/40 group-hover:text-sidebar-foreground/60'}`} />
            {item.label}
          </Link>
        )
      })}
    </div>
  )
}

/** The inner content of the sidebar, shared by the desktop rail and the mobile drawer. */
function SidebarContent({
  orgs,
  activeOrgId,
  onNavigate,
}: {
  orgs: Org[]
  activeOrgId: string
  onNavigate?: () => void
}) {
  const pathname = usePathname()
  const router = useRouter()
  const { toast } = useToast()
  const [orgOpen, setOrgOpen] = useState(false)
  const [switching, setSwitching] = useState(false)
  const orgRef = useRef<HTMLDivElement>(null)
  const activeOrg = orgs.find((o) => o.id === activeOrgId)

  useEffect(() => {
    if (!orgOpen) return
    function onClick(e: MouseEvent) {
      if (orgRef.current && !orgRef.current.contains(e.target as Node)) setOrgOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [orgOpen])

  async function handleSwitchOrg(org: Org) {
    setOrgOpen(false)
    if (org.id === activeOrgId || switching) return
    setSwitching(true)
    const result = await setActiveOrg(org.id)
    setSwitching(false)
    if (result.error) {
      toast({ variant: 'error', title: 'Could not switch', description: result.error })
      return
    }
    toast({ variant: 'success', title: 'Switched workspace', description: org.name })
    router.refresh()
  }

  return (
    <>
      {/* Brand + org switcher */}
      <div className="flex flex-col gap-2 px-3 pt-4 pb-2">
        <div className="flex items-center gap-2 px-1">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-sidebar-primary">
            <Sparkles className="size-3.5 text-sidebar-primary-foreground" />
          </div>
          <span className="text-sm font-bold tracking-tight text-sidebar-foreground">LeadFlow</span>
        </div>

        {/* Org switcher */}
        <div className="relative" ref={orgRef}>
          <button
            onClick={() => setOrgOpen(!orgOpen)}
            disabled={switching}
            aria-haspopup="menu"
            aria-expanded={orgOpen}
            className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-xs text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground disabled:opacity-60"
          >
            <span className="truncate">{switching ? 'Switching…' : activeOrg?.name ?? 'Select org'}</span>
            <ChevronDown className={`size-3 transition-transform ${orgOpen ? 'rotate-180' : ''}`} />
          </button>

          {orgOpen && (
            <div role="menu" className="absolute left-0 top-full z-50 mt-1 w-full rounded-lg border border-sidebar-border bg-sidebar p-1 shadow-xl">
              {orgs.map((org) => (
                <button
                  key={org.id}
                  role="menuitemradio"
                  aria-checked={org.id === activeOrgId}
                  onClick={() => handleSwitchOrg(org)}
                  className={`flex w-full items-center rounded-md px-2.5 py-1.5 text-xs transition-colors ${
                    org.id === activeOrgId
                      ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                      : 'text-sidebar-foreground/60 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
                  }`}
                >
                  <span className="truncate">{org.name}</span>
                  <span className="ml-auto text-[10px] text-sidebar-foreground/30">{org.role}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Search shortcut */}
      <div className="px-3 pb-2">
        <button
          onClick={() => {
            onNavigate?.()
            window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT))
          }}
          className="flex w-full items-center gap-2 rounded-lg border border-sidebar-border/50 bg-sidebar-accent/30 px-2.5 py-1.5 text-xs text-sidebar-foreground/40 transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground/60"
        >
          <Search className="size-3.5" />
          <span>Search...</span>
          <kbd className="ml-auto rounded bg-sidebar-accent px-1.5 py-0.5 font-mono text-[10px] text-sidebar-foreground/30">
            /
          </kbd>
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-5 overflow-y-auto px-2 py-2">
        <NavSection label="Overview" items={MAIN_NAV} pathname={pathname} onNavigate={onNavigate} />
        <NavSection label="Manage" items={MANAGE_NAV} pathname={pathname} onNavigate={onNavigate} />
        <NavSection label="Data" items={DATA_NAV} pathname={pathname} onNavigate={onNavigate} />
      </nav>

      {/* Footer */}
      <div className="border-t border-sidebar-border px-2 py-2">
        <Link
          href="/settings"
          onClick={onNavigate}
          className={`group flex h-8 items-center gap-2.5 rounded-lg px-3 text-[13px] font-medium transition-all duration-150 ${
            pathname.startsWith('/settings')
              ? 'bg-sidebar-accent text-sidebar-accent-foreground'
              : 'text-sidebar-foreground/60 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
          }`}
        >
          <Settings className={`size-4 shrink-0 ${pathname.startsWith('/settings') ? 'text-sidebar-primary' : 'text-sidebar-foreground/40 group-hover:text-sidebar-foreground/60'}`} />
          Settings
        </Link>
      </div>
    </>
  )
}

/** Desktop sidebar rail — hidden below the lg breakpoint. */
export function Sidebar({ orgs, activeOrgId }: { orgs: Org[]; activeOrgId: string }) {
  return (
    <aside className="hidden w-[220px] shrink-0 flex-col bg-sidebar lg:flex">
      <SidebarContent orgs={orgs} activeOrgId={activeOrgId} />
    </aside>
  )
}

/** Mobile drawer sidebar — slides in from the left, shown only below lg. */
export function MobileSidebar({
  orgs,
  activeOrgId,
  open,
  onClose,
}: {
  orgs: Org[]
  activeOrgId: string
  open: boolean
  onClose: () => void
}) {
  return (
    <div className={`lg:hidden ${open ? '' : 'pointer-events-none'}`} aria-hidden={!open}>
      {/* Backdrop */}
      <div
        onClick={onClose}
        className={`fixed inset-0 z-40 bg-black/50 transition-opacity duration-200 ${
          open ? 'opacity-100' : 'opacity-0'
        }`}
      />
      {/* Drawer */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className={`fixed inset-y-0 left-0 z-50 flex w-[260px] flex-col bg-sidebar shadow-2xl transition-transform duration-200 ease-out ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <button
          onClick={onClose}
          aria-label="Close navigation"
          className="absolute right-2 top-3 flex h-7 w-7 items-center justify-center rounded-lg text-sidebar-foreground/50 transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
        >
          <X className="size-4" />
        </button>
        <SidebarContent orgs={orgs} activeOrgId={activeOrgId} onNavigate={onClose} />
      </aside>
    </div>
  )
}
