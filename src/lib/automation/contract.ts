import { z } from 'zod/v4'

// The one message format between FlowLead and the automation engine (n8n), in both
// directions. docs/contracts/*.schema.json are generated from these schemas
// (`pnpm contracts:export`) and n8n validates against the same shapes before sending.
//
//   event_id        unique per message; the receiver's idempotency key
//   correlation_id  on a reply: the event_id of the request it answers
//   subject_id      the record the event is about (e.g. the lead)
//   expected_version optimistic-lock version the sender saw, when relevant

const envelope = z.object({
  event_id: z.uuid(),
  organization_id: z.uuid(),
  subject_id: z.uuid(),
  correlation_id: z.uuid().optional(),
  expected_version: z.number().int().positive().optional(),
})

const shortText = (max: number) => z.string().max(max).nullable()

export const leadEnrichmentRequestedSchema = envelope.extend({
  event_type: z.literal('lead.enrichment.requested'),
  payload: z.object({
    full_name: shortText(500),
    company_name: shortText(500),
    website: shortText(2000),
  }),
})

export const researchSchema = z.object({
  tier: z.enum(['basic', 'standard', 'deep']).default('basic'),
  status: z.enum(['pending', 'running', 'completed', 'failed']).default('completed'),
  company_summary: z.string().max(20000).nullish(),
  website_analysis: z.string().max(20000).nullish(),
  pain_points: z.array(z.string().max(2000)).max(50).nullish(),
  recommended_offer: z.string().max(5000).nullish(),
  outreach_angle: z.string().max(5000).nullish(),
  objections: z.array(z.string().max(2000)).max(50).nullish(),
  next_best_action: z.string().max(5000).nullish(),
  lead_score: z.number().int().min(0).max(100).nullish(),
  confidence_score: z.number().min(0).max(1).nullish(),
  model: z.string().max(200).nullish(),
  error_message: z.string().max(2000).nullish(),
})

// One entry per paid model call, so every enrichment's cost lands in ai_usage_log.
export const usageSchema = z.object({
  model: z.string().max(200),
  prompt_tokens: z.number().int().min(0).nullish(),
  completion_tokens: z.number().int().min(0).nullish(),
  cost_usd: z.number().min(0).max(100).nullish(),
  latency_ms: z.number().int().min(0).nullish(),
})

export const leadEnrichedSchema = envelope.extend({
  event_type: z.literal('lead.enriched'),
  payload: z.object({
    research: researchSchema,
    lead_update: z
      .object({
        lead_score: z.number().int().min(0).max(100).optional(),
        lead_quality: z.enum(['hot', 'warm', 'cold']).optional(),
        ai_status: z.enum(['pending', 'running', 'completed', 'failed']).optional(),
      })
      .optional(),
    usage: z.array(usageSchema).max(20).optional(),
  }),
})

export type LeadEnrichmentRequested = z.infer<typeof leadEnrichmentRequestedSchema>
export type LeadEnriched = z.infer<typeof leadEnrichedSchema>

/** Every contract, keyed by event_type. Used to generate docs/contracts/*.schema.json. */
// ---- Follow-ups (spec: Obsidian SALES-OS/INTERNAL/FLOWLEAD_FOLLOWUPS_SPEC_2026-09-24.md) ----
// subject_id is the follow_ups row. The engine drafts the email and may propose to delay or
// skip the step; FlowLead enforces the bounds (never earlier, never past latest_allowed).

const historyItem = z.object({
  direction: z.enum(['outbound', 'inbound']),
  subject: shortText(500),
  body: z.string().max(10000),
  at: z.string().max(40),
})

export const followUpDraftRequestedSchema = envelope.extend({
  event_type: z.literal('followup.draft.requested'),
  payload: z.object({
    lead_id: z.uuid(),
    step: z.number().int().min(1).max(10),
    max_steps: z.number().int().min(1).max(10),
    scheduled_for: z.string().max(40),
    latest_allowed: z.string().max(40), // the furthest the engine may delay this step
    contact: z.object({
      full_name: shortText(500),
      email: z.string().max(320),
      company_name: shortText(500),
      job_title: shortText(500),
    }),
    research: z
      .object({
        company_summary: shortText(20000),
        pain_points: z.array(z.string().max(2000)).max(50).nullable(),
        recommended_offer: shortText(5000),
        outreach_angle: shortText(5000),
        next_best_action: shortText(5000),
      })
      .nullable(),
    enquiry: shortText(5000), // what the lead told us (form message / booking notes)
    history: z.array(historyItem).max(20),
    sender: z.object({ name: shortText(200), company: shortText(200) }),
    rules: z.object({ booking_link_allowed: z.boolean(), max_words: z.number().int().min(30).max(400) }),
  }),
})

export const followUpDraftedSchema = envelope.extend({
  event_type: z.literal('followup.drafted'),
  payload: z.object({
    decision: z.enum(['send', 'delay', 'skip']),
    reason: z.string().min(1).max(1000),
    subject: z.string().min(1).max(300).optional(),
    body: z.string().min(1).max(8000).optional(),
    delay_until: z.string().max(40).optional(),
    usage: z.array(usageSchema).max(20).optional(),
  }).refine((p) => p.decision !== 'send' || (p.subject && p.body), { message: 'send needs subject and body' })
    .refine((p) => p.decision !== 'delay' || p.delay_until, { message: 'delay needs delay_until' }),
})

export type FollowUpDraftRequested = z.infer<typeof followUpDraftRequestedSchema>
export type FollowUpDrafted = z.infer<typeof followUpDraftedSchema>

export const CONTRACTS = {
  'lead.enrichment.requested': leadEnrichmentRequestedSchema,
  'lead.enriched': leadEnrichedSchema,
  'followup.draft.requested': followUpDraftRequestedSchema,
  'followup.drafted': followUpDraftedSchema,
} as const
