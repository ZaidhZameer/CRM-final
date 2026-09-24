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
export const CONTRACTS = {
  'lead.enrichment.requested': leadEnrichmentRequestedSchema,
  'lead.enriched': leadEnrichedSchema,
} as const
