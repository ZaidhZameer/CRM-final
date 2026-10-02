import { notFound } from 'next/navigation'
import { createServiceClient } from '@/lib/supabase/service'
import { AuditFlow } from './audit-flow'

export const metadata = { title: 'Free website check', robots: { index: true } }

export default async function AuditPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const service = createServiceClient()
  const { data: form } = await service.from('lead_forms').select('id, organization_id, is_active').eq('slug', slug).maybeSingle()
  if (!form || !form.is_active) notFound()
  const { data: org } = await service.from('organizations').select('name').eq('id', form.organization_id).single()

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-background to-muted/30 p-4">
      <div className="w-full max-w-lg rounded-xl border bg-background p-8 shadow-lg">
        <p className="text-center text-xs font-medium uppercase tracking-wider text-muted-foreground">{org?.name ?? 'LeadFlow'}</p>
        <h1 className="mt-1 text-center text-2xl font-bold">Free website check</h1>
        <p className="mt-2 mb-6 text-center text-sm text-muted-foreground">
          Enter your website and see in seconds what could be costing you enquiries. No sign-up needed.
        </p>
        <AuditFlow formId={form.id} orgId={form.organization_id} />
      </div>
    </div>
  )
}
