import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { createServiceClient } from '@/lib/supabase/service'
import type { ProposalSections } from '@/lib/proposals'
import { formatPrice } from '@/app/(dashboard)/proposals/format'

// Public, read-only proposal for the client (the share link). No login, no tracking.
// Only approved/sent/accepted proposals are shown, and only the proposal itself: never
// research, scores, notes or anything else from the CRM.

export const metadata: Metadata = { title: 'Proposal', robots: { index: false, follow: false } }
export const dynamic = 'force-dynamic'

function Block({ title, text }: { title: string; text?: string }) {
  return text?.trim() ? (
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="whitespace-pre-line leading-relaxed text-neutral-700">{text}</p>
      </section>
    ) : null
}

function List({ title, items }: { title: string; items?: string[] }) {
  return items?.length ? (
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{title}</h2>
        <ul className="list-disc space-y-1 pl-5 text-neutral-700">{items.map((x, i) => <li key={i}>{x}</li>)}</ul>
      </section>
    ) : null
}

export default async function PublicProposalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  if (!/^[0-9a-f]{64}$/.test(token)) notFound()

  const service = createServiceClient()
  const { data: p } = await service
    .from('proposals')
    .select('title, content_json, price_amount, currency, price_type, price_notes, valid_until, status, organization_id, leads(companies(name))')
    .eq('share_token', token)
    .in('status', ['approved', 'sent', 'accepted'])
    .is('deleted_at', null)
    .maybeSingle()
  if (!p) notFound()

  const { data: org } = await service.from('organizations').select('name').eq('id', p.organization_id).single()
  const s = ((p.content_json ?? {}) as { sections?: Partial<ProposalSections> }).sections ?? {}
  const client = (p.leads as unknown as { companies: { name: string | null } | null } | null)?.companies?.name
  const expired = p.valid_until && new Date(`${p.valid_until}T23:59:59`) < new Date() && p.status !== 'accepted'

  return (
    <main className="min-h-screen bg-white px-4 py-12 text-neutral-900 print:py-0">
      <article className="mx-auto max-w-2xl space-y-8">
        <header className="space-y-2 border-b pb-6">
          <p className="text-sm uppercase tracking-wide text-neutral-500">{org?.name ?? 'Proposal'}{client ? ` · for ${client}` : ''}</p>
          <h1 className="text-3xl font-bold">{p.title}</h1>
          {expired && <p className="text-sm text-red-600">This proposal has passed its valid-until date. Please get in touch for an updated version.</p>}
        </header>
        <Block title="Summary" text={s.summary} />
        <Block title="Your situation" text={s.situation} />
        <Block title="What we propose" text={s.solution} />
        <List title="Scope & deliverables" items={s.scope} />
        <Block title="Timeline" text={s.timeline} />
        <List title="Assumptions" items={s.assumptions} />
        <section className="space-y-1 rounded-lg border p-5">
          <h2 className="text-lg font-semibold">Investment</h2>
          <p className="text-2xl font-bold tabular-nums">{formatPrice({ price_amount: p.price_amount === null ? null : Number(p.price_amount), currency: p.currency, price_type: p.price_type })}</p>
          {p.price_notes && <p className="text-sm text-neutral-600">{p.price_notes}</p>}
          {p.valid_until && <p className="text-xs text-neutral-500">Valid until {new Date(p.valid_until).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</p>}
        </section>
        <Block title="Next steps" text={s.next_steps} />
      </article>
    </main>
  )
}
