'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

export type JobRow = {
  id: string
  job_type: string
  subject_type: string | null
  status: string
  attempts: number
  error_message: string | null
  created_at: string
  finished_at: string | null
}

export async function getJobs(params: { status?: string }): Promise<{ jobs: JobRow[] }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/sign-in')

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, default_organization_id')
    .eq('user_id', user.id)
    .single()

  if (!profile?.default_organization_id) return { jobs: [] }

  let query = supabase
    .from('jobs')
    .select('id, job_type, subject_type, status, attempts, error_message, created_at, finished_at')
    .eq('organization_id', profile.default_organization_id)
    .order('created_at', { ascending: false })
    .limit(100)

  if (params.status) {
    query = query.eq('status', params.status)
  }

  const { data } = await query

  const jobs: JobRow[] = (data ?? []).map((r: { id: string; job_type: string; subject_type: string | null; status: string; attempts: number; error_message: string | null; created_at: string; finished_at: string | null }) => ({
    id: r.id,
    job_type: r.job_type,
    subject_type: r.subject_type,
    status: r.status,
    attempts: r.attempts,
    error_message: r.error_message,
    created_at: r.created_at,
    finished_at: r.finished_at,
  }))

  return { jobs }
}
