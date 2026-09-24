'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { queueApprovedFollowUp, closeRejectedFollowUp } from '@/lib/follow-up-sender'
import { revalidatePath } from 'next/cache'

export type ApprovalRow = {
  id: string
  title: string
  summary: string | null
  tier: string
  action_type: string
  status: string
  created_at: string
  expires_at: string | null
  version: number
  decision_note: string | null
  payload_json: Record<string, unknown> | null
}

export async function getApprovals(): Promise<{ approvals: ApprovalRow[] }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/sign-in')

  // Profile lookup goes through the service client like the rest of the app: the
  // profiles_select RLS policy is self-referential and errors for the user client.
  const { data: profile } = await createServiceClient()
    .from('profiles')
    .select('id, default_organization_id')
    .eq('user_id', user.id)
    .single()

  if (!profile?.default_organization_id) return { approvals: [] }

  const [{ data: pending }, { data: recent }] = await Promise.all([
    supabase
      .from('approvals')
      .select('id, title, summary, tier, action_type, status, created_at, expires_at, version, decision_note, payload_json')
      .eq('organization_id', profile.default_organization_id)
      .eq('status', 'pending')
      .order('created_at', { ascending: false }),
    supabase
      .from('approvals')
      .select('id, title, summary, tier, action_type, status, created_at, expires_at, version, decision_note, payload_json')
      .eq('organization_id', profile.default_organization_id)
      .neq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(30)
  ])

  const rows = [...(pending || []), ...(recent || [])]
  
  return { approvals: rows as ApprovalRow[] }
}

export async function decideApprovalAction(
  approvalId: string,
  decision: 'approved' | 'rejected',
  expectedVersion: number,
  note?: string
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/sign-in')

  const { error } = await supabase.rpc('decide_approval', {
    p_approval_id: approvalId,
    p_decision: decision,
    p_expected_version: expectedVersion,
    p_note: note || null,
    p_edited_payload: null
  })

  if (error) {
    let message = 'An unknown error occurred.'
    switch (error.message) {
      case 'approval_not_found': message = 'Approval not found or access denied.'; break
      case 'not_allowed': message = 'You do not have permission to decide this approval.'; break
      case 'approval_not_pending': message = 'This approval has already been decided.'; break
      case 'approval_expired': message = 'This approval has expired.'; break
      case 'version_conflict': message = 'This approval was updated by someone else. Please refresh and try again.'; break
      case 'edits_require_approval': message = 'You can only edit the payload when approving.'; break
      case 'invalid_decision': message = 'Invalid decision. Must be approved or rejected.'; break
      default: message = error.message; break
    }
    return { error: message }
  }

  // Side effects of the decision. Approving a follow-up only queues it: the lifecycle cron
  // sends it at its scheduled time from the connected mailbox.
  const service = createServiceClient()
  if (decision === 'approved') await queueApprovedFollowUp(service, approvalId)
  else await closeRejectedFollowUp(service, approvalId)

  revalidatePath('/approvals')
  return { success: true }
}
