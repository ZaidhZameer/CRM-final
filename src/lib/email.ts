import { Resend } from 'resend'

// Created on first send, not at import: `new Resend(undefined)` throws, which crashed every
// route importing this module whenever RESEND_API_KEY was unset.
let client: Resend | null = null
const resend = {
  emails: {
    async send(...args: Parameters<Resend['emails']['send']>) {
      const key = process.env.RESEND_API_KEY
      if (!key) {
        console.warn('[email] RESEND_API_KEY is not set; email skipped')
        return { data: null, error: { name: 'missing_api_key', message: 'Email is not configured' } }
      }
      client ??= new Resend(key)
      return client.emails.send(...args)
    },
  },
}

const FROM = process.env.NEXT_PUBLIC_EMAIL_FROM ?? 'LeadFlow CRM <onboarding@resend.dev>'

// ============================================================
// Email templates
// ============================================================

export async function sendWelcomeEmail(to: string, name: string) {
  try {
    await resend.emails.send({
      from: FROM,
      to,
      subject: 'Welcome to LeadFlow CRM!',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 40px 20px;">
          <h1 style="font-size: 24px; font-weight: 700; color: #111;">Welcome to LeadFlow, ${escapeHtml(name)}!</h1>
          <p style="font-size: 15px; color: #555; line-height: 1.6;">
            Your account is ready. Here's how to get started:
          </p>
          <ol style="font-size: 15px; color: #555; line-height: 1.8; padding-left: 20px;">
            <li><strong>Import leads</strong> — Upload a CSV to bring in your contacts</li>
            <li><strong>Score & research</strong> — Let AI analyze and score your leads</li>
            <li><strong>Manage pipeline</strong> — Drag leads through your sales stages</li>
            <li><strong>Close deals</strong> — Track deals and convert to projects</li>
          </ol>
          <a href="${(process.env.NEXT_PUBLIC_APP_URL ?? '').split(',')[0].trim()}/dashboard"
             style="display: inline-block; margin-top: 16px; padding: 12px 24px; background: #111; color: #fff; text-decoration: none; border-radius: 6px; font-size: 14px; font-weight: 600;">
            Go to Dashboard
          </a>
          <p style="font-size: 13px; color: #999; margin-top: 32px;">
            — The LeadFlow CRM Team
          </p>
        </div>
      `,
    })
    return { success: true }
  } catch (err: any) {
    console.error('Welcome email failed:', err.message)
    return { error: err.message }
  }
}

export async function sendImportCompleteEmail(
  to: string,
  name: string,
  stats: { total: number; imported: number; duplicates: number; failed: number; batchName: string }
) {
  try {
    await resend.emails.send({
      from: FROM,
      to,
      subject: `Import complete: ${stats.imported} leads added`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 40px 20px;">
          <h1 style="font-size: 24px; font-weight: 700; color: #111;">Import Complete</h1>
          <p style="font-size: 15px; color: #555;">Hi ${escapeHtml(name)}, your CSV import has finished.</p>

          <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
            <tr style="border-bottom: 1px solid #eee;">
              <td style="padding: 8px 0; font-size: 14px; color: #555;">File</td>
              <td style="padding: 8px 0; font-size: 14px; font-weight: 600; text-align: right;">${escapeHtml(stats.batchName)}</td>
            </tr>
            <tr style="border-bottom: 1px solid #eee;">
              <td style="padding: 8px 0; font-size: 14px; color: #555;">Total Rows</td>
              <td style="padding: 8px 0; font-size: 14px; font-weight: 600; text-align: right;">${stats.total}</td>
            </tr>
            <tr style="border-bottom: 1px solid #eee;">
              <td style="padding: 8px 0; font-size: 14px; color: #2e7d32;">Imported</td>
              <td style="padding: 8px 0; font-size: 14px; font-weight: 600; color: #2e7d32; text-align: right;">${stats.imported}</td>
            </tr>
            <tr style="border-bottom: 1px solid #eee;">
              <td style="padding: 8px 0; font-size: 14px; color: #f57c00;">Duplicates</td>
              <td style="padding: 8px 0; font-size: 14px; font-weight: 600; color: #f57c00; text-align: right;">${stats.duplicates}</td>
            </tr>
            ${stats.failed > 0 ? `
            <tr>
              <td style="padding: 8px 0; font-size: 14px; color: #d32f2f;">Failed</td>
              <td style="padding: 8px 0; font-size: 14px; font-weight: 600; color: #d32f2f; text-align: right;">${stats.failed}</td>
            </tr>` : ''}
          </table>

          <a href="${(process.env.NEXT_PUBLIC_APP_URL ?? '').split(',')[0].trim()}/leads"
             style="display: inline-block; margin-top: 8px; padding: 12px 24px; background: #111; color: #fff; text-decoration: none; border-radius: 6px; font-size: 14px; font-weight: 600;">
            View Leads
          </a>
          <p style="font-size: 13px; color: #999; margin-top: 32px;">
            — LeadFlow CRM
          </p>
        </div>
      `,
    })
    return { success: true }
  } catch (err: any) {
    console.error('Import email failed:', err.message)
    return { error: err.message }
  }
}

export async function sendTaskReminderEmail(
  to: string,
  name: string,
  tasks: { title: string; dueDate: string; priority: string }[]
) {
  const taskRows = tasks
    .map(
      (t) => `
      <tr style="border-bottom: 1px solid #eee;">
        <td style="padding: 8px 0; font-size: 14px;">${escapeHtml(t.title)}</td>
        <td style="padding: 8px 0; font-size: 14px; text-align: center;">
          <span style="padding: 2px 8px; border-radius: 10px; font-size: 12px; font-weight: 600;
            background: ${t.priority === 'urgent' ? '#ffebee' : t.priority === 'high' ? '#fff3e0' : '#e3f2fd'};
            color: ${t.priority === 'urgent' ? '#c62828' : t.priority === 'high' ? '#e65100' : '#1565c0'};">
            ${t.priority}
          </span>
        </td>
        <td style="padding: 8px 0; font-size: 14px; color: #555; text-align: right;">${t.dueDate}</td>
      </tr>`
    )
    .join('')

  try {
    await resend.emails.send({
      from: FROM,
      to,
      subject: `You have ${tasks.length} task${tasks.length > 1 ? 's' : ''} due today`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 40px 20px;">
          <h1 style="font-size: 24px; font-weight: 700; color: #111;">Task Reminder</h1>
          <p style="font-size: 15px; color: #555;">Hi ${escapeHtml(name)}, you have tasks due today:</p>

          <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
            <thead>
              <tr style="border-bottom: 2px solid #eee;">
                <th style="padding: 8px 0; font-size: 13px; color: #999; text-align: left;">Task</th>
                <th style="padding: 8px 0; font-size: 13px; color: #999; text-align: center;">Priority</th>
                <th style="padding: 8px 0; font-size: 13px; color: #999; text-align: right;">Due</th>
              </tr>
            </thead>
            <tbody>${taskRows}</tbody>
          </table>

          <a href="${(process.env.NEXT_PUBLIC_APP_URL ?? '').split(',')[0].trim()}/tasks"
             style="display: inline-block; margin-top: 8px; padding: 12px 24px; background: #111; color: #fff; text-decoration: none; border-radius: 6px; font-size: 14px; font-weight: 600;">
            View Tasks
          </a>
          <p style="font-size: 13px; color: #999; margin-top: 32px;">
            — LeadFlow CRM
          </p>
        </div>
      `,
    })
    return { success: true }
  } catch (err: any) {
    console.error('Task reminder email failed:', err.message)
    return { error: err.message }
  }
}

export async function sendBookingNotificationEmail(
  to: string,
  organizerName: string,
  booking: {
    guestName: string
    guestEmail: string
    company: string
    phone?: string | null
    notes?: string | null
    meetingTime: string
    meetLink?: string
    orgName: string
  }
) {
  try {
    await resend.emails.send({
      from: FROM,
      to,
      subject: `New booking: ${booking.guestName} from ${booking.company}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 40px 20px;">
          <h1 style="font-size: 24px; font-weight: 700; color: #111;">New Meeting Booked</h1>
          <p style="font-size: 15px; color: #555; line-height: 1.6;">
            Hi ${escapeHtml(organizerName)}, someone just booked a meeting with you through your ${escapeHtml(booking.orgName)} booking page.
          </p>

          <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
            <tr style="border-bottom: 1px solid #eee;">
              <td style="padding: 10px 0; font-size: 14px; color: #999; width: 100px;">Name</td>
              <td style="padding: 10px 0; font-size: 14px; font-weight: 600;">${escapeHtml(booking.guestName)}</td>
            </tr>
            <tr style="border-bottom: 1px solid #eee;">
              <td style="padding: 10px 0; font-size: 14px; color: #999;">Email</td>
              <td style="padding: 10px 0; font-size: 14px;">${escapeHtml(booking.guestEmail)}</td>
            </tr>
            <tr style="border-bottom: 1px solid #eee;">
              <td style="padding: 10px 0; font-size: 14px; color: #999;">Company</td>
              <td style="padding: 10px 0; font-size: 14px;">${escapeHtml(booking.company)}</td>
            </tr>
            ${booking.phone ? `
            <tr style="border-bottom: 1px solid #eee;">
              <td style="padding: 10px 0; font-size: 14px; color: #999;">Phone</td>
              <td style="padding: 10px 0; font-size: 14px;">${escapeHtml(booking.phone)}</td>
            </tr>` : ''}
            <tr style="border-bottom: 1px solid #eee;">
              <td style="padding: 10px 0; font-size: 14px; color: #999;">When</td>
              <td style="padding: 10px 0; font-size: 14px; font-weight: 600;">${escapeHtml(booking.meetingTime)}</td>
            </tr>
            ${booking.notes ? `
            <tr style="border-bottom: 1px solid #eee;">
              <td style="padding: 10px 0; font-size: 14px; color: #999;">Notes</td>
              <td style="padding: 10px 0; font-size: 14px;">${escapeHtml(booking.notes)}</td>
            </tr>` : ''}
          </table>

          ${booking.meetLink ? `
          <a href="${booking.meetLink}"
             style="display: inline-block; margin-top: 8px; padding: 12px 24px; background: #111; color: #fff; text-decoration: none; border-radius: 6px; font-size: 14px; font-weight: 600;">
            Join Google Meet
          </a>` : ''}

          <p style="font-size: 13px; color: #999; margin-top: 32px;">
            — LeadFlow CRM
          </p>
        </div>
      `,
    })
    return { success: true }
  } catch (err: any) {
    console.error('Booking notification email failed:', err.message)
    return { error: err.message }
  }
}

// Prevent XSS in email HTML
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
