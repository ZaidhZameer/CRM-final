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

  const length = Number(request.headers.get('content-length') ?? 0)
  if (length > MAX_BODY_BYTES) return json(413, 'Request too large')

  const server = buildServer({ service, auth })
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  try {
    const res = await transport.handleRequest(request)
    res.headers.set('Cache-Control', 'no-store')
    return res
  } finally {
    // Closing after the response is built; with JSON responses nothing is left streaming.
    void server.close().catch(() => {})
  }
}
