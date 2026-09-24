'use server'

import { createServiceClient } from '@/lib/supabase/service'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { createLeadFromSubmission } from '@/lib/lead-intake'

export async function submitPublicForm(
  formId: string,
  orgId: string,
  data: Record<string, string>
) {
  // Rate limit by form ID — 20 submissions per minute per form
  const rl = await RATE_LIMITS.form(formId)
  if (!rl.success) return { error: 'Too many submissions. Please try again later.' }

  const service = createServiceClient()

  // Verify form exists and is active
  const { data: form } = await service
    .from('lead_forms')
    .select('id, is_active, organization_id')
    .eq('id', formId)
    .single()

  if (!form || !form.is_active) return { error: 'This form is no longer accepting submissions.' }
  if (form.organization_id !== orgId) return { error: 'Invalid form.' }

  // Sanitize — trim all values, remove empty strings
  const sanitized: Record<string, string> = {}
  for (const [key, val] of Object.entries(data)) {
    const trimmed = val.trim()
    if (trimmed) {
      // Formula injection protection
      const FORMULA_CHARS = ['=', '+', '-', '@', '\t', '\r']
      sanitized[key] = FORMULA_CHARS.some(c => trimmed.startsWith(c)) ? "'" + trimmed : trimmed
    }
  }

  if (Object.keys(sanitized).length === 0) {
    return { error: 'Please fill in at least one field.' }
  }

  // Insert submission
  const { data: submission, error } = await service
    .from('lead_form_submissions')
    .insert({
      form_id: formId,
      organization_id: orgId,
      data_json: sanitized,
    })
    .select('id')
    .single()

  if (error || !submission) return { error: 'Failed to submit. Please try again.' }

  // Speed to lead: the enquiry becomes a lead (deduped, researched) immediately instead of
  // waiting for someone to click "Convert". If that fails, the submission is still saved and
  // can be converted by hand, so the visitor always gets a success response.
  try {
    const intake = await createLeadFromSubmission(service, orgId, submission.id, sanitized, null)
    if (intake.error) console.error('[forms] auto-convert failed', submission.id, intake.error)
  } catch (err) {
    console.error('[forms] auto-convert threw', submission.id, err instanceof Error ? err.message : err)
  }

  // Increment submission count
  const { data: current } = await service
    .from('lead_forms')
    .select('submission_count')
    .eq('id', formId)
    .single()
  if (current) {
    await service
      .from('lead_forms')
      .update({ submission_count: (current.submission_count ?? 0) + 1 })
      .eq('id', formId)
  }

  return { success: true }
}
