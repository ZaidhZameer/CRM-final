// Content-Security-Policy builder. Currently emitted as Report-Only (see src/proxy.ts).
//
// script-src uses 'unsafe-inline' rather than nonces: the Next docs require fully dynamic
// rendering for nonces, which would opt the static pages (/sign-in, /sign-up, /privacy, ...)
// out of static generation. Move to nonces + 'strict-dynamic' before enforcing this policy.

function originOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

export function buildCsp(opts: {
  supabaseUrl?: string
  sentryDsn?: string
  isDev?: boolean
}): string {
  const supabase = originOf(opts.supabaseUrl)
  const supabaseWs = supabase ? supabase.replace(/^http/, 'ws') : null
  const sentry = originOf(opts.sentryDsn)

  const connect = ["'self'", supabase, supabaseWs, sentry].filter(
    (v): v is string => Boolean(v)
  )

  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': ["'self'", "'unsafe-inline'", ...(opts.isDev ? ["'unsafe-eval'"] : [])],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:', 'https:'],
    // next/font/google self-hosts the font files at build time, so no Google origins are needed.
    'font-src': ["'self'", 'data:'],
    'connect-src': connect,
    // Sentry Replay runs in a blob: worker.
    'worker-src': ["'self'", 'blob:'],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  }

  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ')
}
