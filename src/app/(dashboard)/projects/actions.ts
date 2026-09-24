'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { validate, createProjectSchema, projectStatusSchema, uuidSchema } from '@/lib/validate'

export async function getProjects() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/sign-in')

  const service = createServiceClient()

  const { data: profile } = await service
    .from('profiles')
    .select('id, default_organization_id')
    .eq('user_id', user.id)
    .single()

  if (!profile?.default_organization_id) return { projects: [], wonDeals: [] }

  const { data: projects } = await service
    .from('projects')
    .select('id, name, type, status, budget, deadline, github_repo, staging_url, live_url, created_at, deal_id, client_company_id, companies:client_company_id(name)')
    .eq('organization_id', profile.default_organization_id)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })

  // Get won deals that haven't been converted to projects yet
  const { data: wonDeals } = await service
    .from('deals')
    .select('id, title, value, lead_id, leads:lead_id(companies(name))')
    .eq('organization_id', profile.default_organization_id)
    .eq('status', 'won')
    .order('created_at', { ascending: false })
    .limit(50)

  // Filter out deals that already have projects
  const projectDealIds = new Set((projects ?? []).map((p: any) => p.deal_id).filter(Boolean))
  const availableDeals = (wonDeals ?? []).filter((d: any) => !projectDealIds.has(d.id))

  return {
    projects: (projects ?? []).map((p: any) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      status: p.status,
      budget: p.budget,
      deadline: p.deadline,
      githubRepo: p.github_repo,
      stagingUrl: p.staging_url,
      liveUrl: p.live_url,
      createdAt: p.created_at,
      dealId: p.deal_id,
      companyName: p.companies?.name ?? null,
    })),
    wonDeals: availableDeals.map((d: any) => ({
      id: d.id,
      title: d.title,
      value: d.value,
      companyName: d.leads?.companies?.name ?? 'Unknown',
    })),
  }
}

export async function createProject(data: {
  name: string
  type?: string
  budget?: number
  deadline?: string
  dealId?: string
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/sign-in')

  const service = createServiceClient()

  const { data: profile } = await service
    .from('profiles')
    .select('id, default_organization_id')
    .eq('user_id', user.id)
    .single()

  if (!profile?.default_organization_id) return { error: 'No org' }

  const v = validate(createProjectSchema, data)
  if (v.error) return { error: v.error }

  const rl = await RATE_LIMITS.write(user.id)
  if (!rl.success) return { error: `Too many requests. Try again in ${rl.resetIn}s.` }

  try {
    // If converting from a deal, get the deal's company
    let clientCompanyId: string | null = null
    if (data.dealId) {
      const { data: deal } = await service
        .from('deals')
        .select('lead_id, leads:lead_id(company_id)')
        .eq('id', data.dealId)
        .single()
      clientCompanyId = (deal as any)?.leads?.company_id ?? null
    }

    const { data: project, error } = await service
      .from('projects')
      .insert({
        organization_id: profile.default_organization_id,
        name: data.name,
        type: data.type || null,
        budget: data.budget || null,
        deadline: data.deadline || null,
        deal_id: data.dealId || null,
        client_company_id: clientCompanyId,
        created_by: profile.id,
      })
      .select('id')
      .single()

    if (error) return { error: error.message }

    await service.from('activity_logs').insert({
      organization_id: profile.default_organization_id,
      actor_profile_id: profile.id,
      action: 'created',
      entity_type: 'project',
      entity_id: project.id,
      after_json: { name: data.name, type: data.type, dealId: data.dealId },
    })

    return { success: true, id: project.id }
  } catch {
    return { error: 'Something went wrong. Please try again.' }
  }
}

export async function updateProjectStatus(projectId: string, status: string) {
  const idCheck = validate(uuidSchema, projectId)
  if (idCheck.error) return { error: 'Invalid project ID' }

  const statusCheck = validate(projectStatusSchema, status)
  if (statusCheck.error) return { error: statusCheck.error }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/sign-in')

  const service = createServiceClient()

  const { data: profile } = await service
    .from('profiles')
    .select('id, default_organization_id')
    .eq('user_id', user.id)
    .single()

  if (!profile?.default_organization_id) return { error: 'No org' }

  const rl = await RATE_LIMITS.write(user.id)
  if (!rl.success) return { error: `Too many requests. Try again in ${rl.resetIn}s.` }

  try {
    const { error } = await service
      .from('projects')
      .update({ status })
      .eq('id', projectId)
      .eq('organization_id', profile.default_organization_id)

    if (error) return { error: error.message }
    return { success: true }
  } catch {
    return { error: 'Something went wrong. Please try again.' }
  }
}
