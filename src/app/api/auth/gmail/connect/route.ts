import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { GMAIL_STATE_COOKIE, getGmailAuthUrl, isGmailConfigured } from '@/lib/gmail'

// Starts "Connect Gmail" from Settings. Owners/admins only: the mailbox sends on the org's behalf.
export async function GET() {
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').split(',')[0].trim()
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.redirect(new URL('/sign-in', appUrl))
  if (!isGmailConfigured()) return NextResponse.redirect(new URL('/settings?gmail=not_configured', appUrl))

  const service = createServiceClient()
  const { data: profile } = await service
    .from('profiles')
    .select('id, default_organization_id')
    .eq('user_id', user.id)
    .single()
  const { data: membership } = await service
    .from('memberships')
    .select('role')
    .eq('profile_id', profile?.id ?? '')
    .eq('organization_id', profile?.default_organization_id ?? '')
    .eq('status', 'active')
    .maybeSingle()
  if (!membership || !['owner', 'admin'].includes(membership.role)) {
    return NextResponse.redirect(new URL('/settings?gmail=forbidden', appUrl))
  }

  // Random state bound to this browser, so a forged callback can't attach someone else's mailbox.
  const state = randomBytes(24).toString('base64url')
  const res = NextResponse.redirect(getGmailAuthUrl(state))
  res.cookies.set(GMAIL_STATE_COOKIE, state, {
    httpOnly: true,
    secure: appUrl.startsWith('https://'),
    sameSite: 'lax',
    path: '/api/auth/gmail',
    maxAge: 600,
  })
  return res
}
