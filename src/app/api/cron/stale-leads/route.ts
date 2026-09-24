import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { verifyCronSecret } from '@/lib/automation/secret'

// Cron: Runs daily. Finds leads with no activity for 7+ days and auto-creates follow-up tasks.
// GET /api/cron/stale-leads   (header: x-cron-secret)

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request).ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const service = createServiceClient()

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
    return NextResponse.json({ message: 'No stale leads found', created: 0 })
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
        due_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // due tomorrow
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
  })
}
