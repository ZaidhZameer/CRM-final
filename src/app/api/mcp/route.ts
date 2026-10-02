import { createServiceClient } from '@/lib/supabase/service'
import { handleMcp } from '@/lib/mcp/handler'

// POST /api/mcp: FlowLead MCP server (Streamable HTTP). Bearer-token auth is done in the handler;
// the route is listed in PUBLIC_ROUTES in src/proxy.ts only so the cookie-session redirect skips it.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const handle = (request: Request) => handleMcp(request, createServiceClient())

export const POST = handle
export const GET = handle
export const DELETE = handle
