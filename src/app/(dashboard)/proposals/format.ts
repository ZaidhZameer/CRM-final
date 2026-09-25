import type { Badge } from '@/components/ui/badge'

type BadgeTone = React.ComponentProps<typeof Badge>['tone']

export const STATUS_TONES: Record<string, BadgeTone> = {
  draft: 'amber', approved: 'blue', sent: 'blue', accepted: 'emerald', declined: 'red', expired: 'neutral', withdrawn: 'neutral',
}

export function formatPrice(p: { price_amount: number | null; currency: string; price_type: string }) {
  if (p.price_amount === null) return 'No price yet'
  const amount = new Intl.NumberFormat('en-GB', { style: 'currency', currency: p.currency, maximumFractionDigits: 2 }).format(p.price_amount)
  return p.price_type === 'monthly' ? `${amount} / month` : amount
}
