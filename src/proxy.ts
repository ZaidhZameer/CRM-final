import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { RATE_LIMITS } from '@/lib/rate-limit'

function getIP(request: NextRequest): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    '127.0.0.1'
  )
}

// '/book/' is the public booking page prospects open. '/api/automation/' and '/api/cron/'
// are machine-to-machine: they have no session and authenticate with their own
// fail-closed shared-secret header instead.
const PUBLIC_ROUTES = [
  '/sign-in', '/sign-up', '/auth/callback', '/auth/confirm', '/reset-password', '/f/', '/privacy', '/terms',
  '/book/', '/api/automation/', '/api/cron/',
]

export default async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  const ip = getIP(request)

  // Rate limit auth routes — only POST (actual login/signup attempts), not page views
  if (
    request.method === 'POST' &&
    (pathname.startsWith('/sign-in') || pathname.startsWith('/sign-up') || pathname.startsWith('/reset-password'))
  ) {
    const rl = await RATE_LIMITS.auth(ip)
    if (!rl.success) {
      return new NextResponse('Too many requests. Please try again later.', {
        status: 429,
        headers: { 'Retry-After': String(rl.resetIn) },
      })
    }
  }

  // Rate limit API routes (60/min per IP, skip cron — those use secret auth)
  if (pathname.startsWith('/api/') && !pathname.startsWith('/api/cron')) {
    const rl = await RATE_LIMITS.api(ip)
    if (!rl.success) {
      return NextResponse.json(
        { error: 'Too many requests' },
        { status: 429, headers: { 'Retry-After': String(rl.resetIn) } }
      )
    }
  }

  // Rate limit public form pages (20/min per IP)
  if (pathname.startsWith('/f/')) {
    const rl = await RATE_LIMITS.form(ip)
    if (!rl.success) {
      return new NextResponse('Too many submissions. Please try again later.', {
        status: 429,
        headers: { 'Retry-After': String(rl.resetIn) },
      })
    }
  }

  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const isPublicRoute = PUBLIC_ROUTES.some((route) => pathname.startsWith(route))

  if (!user && !isPublicRoute && pathname !== '/') {
    const url = request.nextUrl.clone()
    url.pathname = '/sign-in'
    return NextResponse.redirect(url)
  }

  // Don't force-redirect authenticated users away from public routes.
  // Let the pages themselves handle it to avoid redirect loops
  // when the profile/org query fails after auth.

  // Security headers
  supabaseResponse.headers.set('X-Frame-Options', 'DENY')
  supabaseResponse.headers.set('X-Content-Type-Options', 'nosniff')
  supabaseResponse.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  supabaseResponse.headers.set('X-DNS-Prefetch-Control', 'on')
  supabaseResponse.headers.set(
    'Strict-Transport-Security',
    'max-age=31536000; includeSubDomains'
  )
  supabaseResponse.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()'
  )

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|mp4|webm|ogg|ico)$).*)',
  ],
}
