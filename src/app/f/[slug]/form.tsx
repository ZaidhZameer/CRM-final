'use client'

import { useState } from 'react'
import { submitPublicForm } from './actions'

const FIELD_LABELS: Record<string, { label: string; type: string; placeholder: string }> = {
  company_name: { label: 'Company Name', type: 'text', placeholder: 'Acme Corp' },
  contact_name: { label: 'Your Name', type: 'text', placeholder: 'John Doe' },
  email: { label: 'Email', type: 'email', placeholder: 'john@example.com' },
  phone: { label: 'Phone', type: 'tel', placeholder: '+1 (555) 123-4567' },
  website: { label: 'Website', type: 'url', placeholder: 'https://example.com' },
  job_title: { label: 'Job Title', type: 'text', placeholder: 'Head of Sales' },
  industry: { label: 'Industry', type: 'text', placeholder: 'Technology' },
  location: { label: 'Location', type: 'text', placeholder: 'New York, NY' },
  message: { label: 'Message', type: 'textarea', placeholder: 'Tell us about your needs...' },
  budget: { label: 'Budget Range', type: 'text', placeholder: '$10k - $50k' },
}

export function PublicLeadForm({
  formId,
  orgId,
  fields,
  thankYouMessage,
}: {
  formId: string
  orgId: string
  fields: string[]
  thankYouMessage: string
}) {
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(fields.map(f => [f, '']))
  )
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    // Basic validation — at least one field must be filled
    const filled = Object.values(values).filter(v => v.trim()).length
    if (filled === 0) {
      setError('Please fill in at least one field.')
      return
    }

    // Email validation if email field exists and is filled
    if (values.email && values.email.trim()) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
      if (!emailRegex.test(values.email.trim())) {
        setError('Please enter a valid email address.')
        return
      }
    }

    setSubmitting(true)
    const result = await submitPublicForm(formId, orgId, values)
    setSubmitting(false)

    if ('error' in result) {
      setError(result.error ?? 'Something went wrong')
    } else {
      setSubmitted(true)
    }
  }

  if (submitted) {
    return (
      <div className="py-8 text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
          <svg className="h-8 w-8 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <p className="text-lg font-medium">{thankYouMessage}</p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {fields.map(field => {
        const config = FIELD_LABELS[field] ?? {
          label: field.replace(/_/g, ' '),
          type: 'text',
          placeholder: '',
        }

        return (
          <div key={field} className="space-y-1.5">
            <label className="text-sm font-medium capitalize">{config.label}</label>
            {config.type === 'textarea' ? (
              <textarea
                value={values[field]}
                onChange={e => setValues(v => ({ ...v, [field]: e.target.value }))}
                placeholder={config.placeholder}
                rows={3}
                className="w-full resize-none rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              />
            ) : (
              <input
                type={config.type}
                value={values[field]}
                onChange={e => setValues(v => ({ ...v, [field]: e.target.value }))}
                placeholder={config.placeholder}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              />
            )}
          </div>
        )
      })}

      {error && (
        <p className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">{error}</p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        {submitting ? 'Submitting...' : 'Submit'}
      </button>

      <p className="text-center text-xs text-muted-foreground">
        We&apos;ll use your details to reply to your enquiry. We may also research publicly available information about your
        business to make our reply relevant, and send a few follow-up emails about your enquiry. You can opt out at any time
        by replying &apos;stop&apos; or emailing us. See our{' '}
        <a href="/privacy" className="underline hover:text-foreground">privacy notice</a>.
      </p>
    </form>
  )
}
