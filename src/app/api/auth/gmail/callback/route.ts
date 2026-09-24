import { timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { GMAIL_SCOPES, GMAIL_STATE_COOKIE, exchangeGmailCode, getGoogleEmail } from '@/lib/gmail'

function sameState(a: string | undefined, b: string | null): boolean {
  if (!a || !b || a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

export async function GET(request: NextRequest) {
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').split(',')[0].trim()
  const back = (status: string) => {
    const res = NextResponse.redirect(new URL(`/settings?gmail=${status}`, appUrl))
    res.cookies.delete({ name: GMAIL_STATE_COOKIE, path: '/api/auth/gmail' })
    return res
  }

  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  if (url.searchParams.get('error') || !code) return back('cancelled')
  if (!sameState(request.cookies.get(GMAIL_STATE_COOKIE)?.value, url.searchParams.get('state'))) {
    return back('error')
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.redirect(new URL('/sign-in', appUrl))

  try {
    const service = createServiceClient()
    const { data: profile } = await service
      .from('profiles')
      .select('id, default_organization_id')
      .eq('user_id', user.id)
      .single()
    if (!profile?.default_organization_id) return back('error')

    const tokens = await exchangeGmailCode(code)
    const granted = (tokens.scope ?? '').split(' ')
    // Google lets users untick scopes on the consent screen; without send we can't do anything.
    if (!granted.includes(GMAIL_SCOPES[0])) return back('missing_permission')

    const email = await getGoogleEmail(tokens.access_token)
    const { error } = await service.from('mail_connections').upsert(
      {
        organization_id: profile.default_organization_id,
        profile_id: profile.id,
        provider: 'gmail',
        email,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token ?? null,
        token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
        scopes: granted,
        status: 'connected',
        last_error: null,
        last_history_id: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'organization_id,provider' }
    )
    if (error) {
      console.error('[gmail] saving connection failed', error.message)
      return back('error')
    }
    return back('connected')
  } catch (err) {
    console.error('[gmail] connect failed', err instanceof Error ? err.message : err)
    return back('error')
  }
}
