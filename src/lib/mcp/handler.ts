import type { SupabaseClient } from '@supabase/supabase-js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { verifyBearer } from '@/lib/api-tokens'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { allowedTools, callTool } from './dispatch'
import { SERVER_INSTRUCTIONS, type McpContext } from './tools'

// MCP over Streamable HTTP, stateless: every request is authenticated on its own (bearer token ->
// profile -> org -> CURRENT role) and gets a fresh server holding only the tools that caller may use.

const MAX_BODY_BYTES = 100_000
const json = (status: number, error: string, headers: Record<string, string> = {}) =>
  Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store', ...headers } })

async function readBodyCapped(request: Request, max: number): Promise<string | null> {
  const reader = request.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const buf = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    buf.set(c, off)
    off += c.byteLength
  }
  return new TextDecoder().decode(buf)
}

/** The rebuilt request computes its own length; a stale or missing header must not carry over. */
function stripLength(h: Headers): Headers {
  const out = new Headers(h)
  out.delete('content-length')
  out.delete('transfer-encoding')
  return out
}

function buildServer(ctx: McpContext) {
  const server = new McpServer({ name: 'flowlead', version: '1.0.0' }, { instructions: SERVER_INSTRUCTIONS })
  for (const t of allowedTools(ctx.auth)) {
    server.registerTool(
      t.name,
      {
        title: t.title,
        description: t.description,
        inputSchema: t.shape,
        annotations: { readOnlyHint: t.scope === 'read', destructiveHint: false, openWorldHint: false },
      },
      async (args: unknown) => callTool(ctx, t.name, args)
    )
  }
  return server
}

export async function handleMcp(request: Request, service: SupabaseClient): Promise<Response> {
  if (request.method !== 'POST') {
    // Stateless server: no standalone SSE stream and no sessions to delete.
    return json(405, 'Method not allowed', { Allow: 'POST' })
  }

  const auth = await verifyBearer(service, request.headers.get('authorization'))
  if (!auth) return json(401, 'Unauthorized', { 'WWW-Authenticate': 'Bearer' })
  if (auth.role === 'client') return json(403, 'Forbidden')

  const rl = await RATE_LIMITS.mcp(auth.tokenId)
  if (!rl.success) return json(429, 'Too many requests', { 'Retry-After': String(rl.resetIn) })

  // Read the body with a hard cap (works with or without Content-Length, HTTP/1 or HTTP/2, chunked
  // or not), then hand the SDK a request with a bounded body.
  const body = await readBodyCapped(request, MAX_BODY_BYTES)
  if (body === null) return json(413, 'Request too large')
  const bounded = new Request(request.url, { method: 'POST', headers: stripLength(request.headers), body })

  const server = buildServer({ service, auth })
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  try {
    const res = await transport.handleRequest(bounded)
    res.headers.set('Cache-Control', 'no-store')
    return res
  } finally {
    // Closing after the response is built; with JSON responses nothing is left streaming.
    void server.close().catch(() => {})
  }
}
