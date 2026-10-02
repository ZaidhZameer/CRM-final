import { z } from 'zod'
import { TOOLS, ToolError, toolAllowed, type McpContext, type ToolDef } from './tools'

// Runs one tool call: permission check, validation, handler, activity log. Used by the SDK server
// and directly by tests.

const MAX_RESULT_CHARS = 60_000

export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

const fail = (message: string): ToolResult => ({ content: [{ type: 'text', text: message }], isError: true })

export function allowedTools(auth: McpContext['auth']): ToolDef[] {
  return TOOLS.filter((t) => toolAllowed(auth, t))
}

async function logCall(ctx: McpContext, tool: string, ok: boolean, leadId: string | null) {
  try {
    // Never the arguments or results: they can contain lead text.
    await ctx.service.from('activity_logs').insert({
      organization_id: ctx.auth.orgId,
      actor_profile_id: ctx.auth.profileId,
      entity_type: 'api_token',
      entity_id: ctx.auth.tokenId,
      action: 'mcp_call',
      after_json: { mcp_tool: tool, token_name: ctx.auth.tokenName, ok, ...(leadId ? { lead_id: leadId } : {}) },
    })
  } catch {
    /* logging must not break the call */
  }
}

export async function callTool(ctx: McpContext, name: string, rawArgs: unknown): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name)
  if (!tool) return fail(`Unknown tool: ${name.slice(0, 60)}`)
  // Re-checked on every call, whatever tools/list showed.
  if (!toolAllowed(ctx.auth, tool)) {
    await logCall(ctx, name, false, null)
    return fail(`Not allowed: this token or role cannot use ${tool.name}.`)
  }
  const parsed = z.object(tool.shape).safeParse(rawArgs ?? {})
  if (!parsed.success) return fail(`Invalid arguments: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`)
  const args = parsed.data as Record<string, unknown>
  const leadId = typeof args.lead_id === 'string' ? args.lead_id : typeof args.id === 'string' && tool.name === 'get_lead' ? args.id : null

  try {
    const result = await tool.handler(ctx, args as never)
    await logCall(ctx, name, true, leadId)
    let text = JSON.stringify(result)
    if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}...[truncated]`
    return { content: [{ type: 'text', text }] }
  } catch (err) {
    await logCall(ctx, name, false, leadId)
    if (err instanceof ToolError) return fail(err.message)
    console.error('[mcp] tool failed', name, err instanceof Error ? err.message : 'unknown')
    return fail('Internal error. Nothing was changed, or the change can be reviewed in FlowLead.')
  }
}
