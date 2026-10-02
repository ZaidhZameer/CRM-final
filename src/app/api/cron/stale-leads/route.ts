import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { verifyCronSecret } from '@/lib/automation/secret'
import { runReactivation } from '@/lib/reactivation'
import { runSourcingForAllOrgs } from '@/lib/sourcing/run'
import { runContactDiscovery } from '@/lib/sourcing/discover-run'

// Cron: Runs daily. Finds leads with no activity for 7+ days and auto-creates follow-up tasks.
// On the first business day of each quarter (UK), or with ?reactivate=1, it also schedules ONE
// approval-gated reactivation check-in for old leads that went quiet (see lib/reactivation.ts).
// GET /api/cron/stale-leads[?reactivate=1]   (header: x-cron-secret)

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request).ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const service = createServiceClient()

  // UK GDPR retention: anonymise unconverted leads idle for 12+ months (see 20261001000001 migration).
  const { data: anonymisedData, error: anonymiseError } = await service.rpc('anonymise_stale_leads', { p_months: 12 })
  if (anonymiseError) console.error('[cron/stale-leads] anonymise failed', anonymiseError.message)
  const anonymised = typeof anonymisedData === 'number' ? anonymisedData : 0

  // Quarterly reactivation (after anonymisation, so anonymised leads are never candidates).
  const reactivation = await runReactivation(service, new Date(), request.nextUrl.searchParams.get('reactivate') === '1')
    .catch((err): Awaited<ReturnType<typeof runReactivation>> => {
      console.error('[cron/stale-leads] reactivation failed', err instanceof Error ? err.message : err)
      return { ran: true, error: 'unexpected failure' }
    })

  // Daily lead sourcing for orgs that switched it on (default OFF; creates leads only, sends nothing).
  const sourcing = await runSourcingForAllOrgs(service).catch((err) => {
    console.error('[cron/stale-leads] sourcing failed', err instanceof Error ? err.message : err)
    return {}
  })

  // Contact discovery for sourced/imported leads with a website but no email (lead_finder agent, level 1+).
  const discovery = await runContactDiscovery(service).catch((err) => {
    console.error('[cron/stale-leads] discovery failed', err instanceof Error ? err.message : err)
    return {}
  })
  void discovery

  // Find all active leads where:
  // 1. Status is NOT converted/lost (still in play)
  // 2. updated_at is older than 7 days
  // 3. No open task already exists for this lead
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const { data: staleLeads } = await service
    .from('leads')
    .select(`
      id, organization_id, company_id, assigned_to, updated_at,
      companies(name),
      contacts(full_name)
    `)
    .is('deleted_at', null)
    .not('status', 'in', '("converted","lost")')
    .lt('updated_at', sevenDaysAgo)
    .limit(500)

  if (!staleLeads || staleLeads.length === 0) {
    return NextResponse.json({ message: 'No stale leads found', created: 0, anonymised, reactivation, sourcing })
  }

  let tasksCreated = 0

  for (const lead of staleLeads) {
    // Check if there's already an open task for this lead
    const { count } = await service
      .from('tasks')
      .select('id', { count: 'exact', head: true })
      .eq('lead_id', lead.id)
      .in('status', ['todo', 'in_progress'])

    if (count && count > 0) continue // already has an open task

    const companyName = (lead as any).companies?.name ?? 'Unknown Company'
    const contactName = (lead as any).contacts?.full_name ?? ''
    const daysSince = Math.floor((Date.now() - new Date(lead.updated_at).getTime()) / (1000 * 60 * 60 * 24))

    // Create a follow-up task
    const { error } = await service
      .from('tasks')
      .insert({
        organization_id: lead.organization_id,
        title: `Follow up: ${companyName}${contactName ? ` (${contactName})` : ''}`,
        description: `This lead has had no activity for ${daysSince} days. Consider reaching out to re-engage.`,
        priority: daysSince > 14 ? 'high' : 'medium',
        status: 'todo',
        due_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // due tomorrow
        lead_id: lead.id,
        assigned_to: lead.assigned_to ?? null,
      })

    if (!error) {
      tasksCreated++

      // Log activity
      await service.from('activity_logs').insert({
        organization_id: lead.organization_id,
        action: 'created',
        entity_type: 'task',
        entity_id: lead.id,
        after_json: { reason: 'auto_stale_reminder', days_inactive: daysSince },
      })
    }
  }

  return NextResponse.json({
    message: `Checked ${staleLeads.length} stale leads, created ${tasksCreated} follow-up tasks`,
    checked: staleLeads.length,
    created: tasksCreated,
    anonymised,
    reactivation,
    sourcing,
  })
}
