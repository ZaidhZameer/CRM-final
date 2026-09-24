'use server'

import { createServiceClient } from '@/lib/supabase/service'
import {
  getFreeBusySlots,
  getValidAccessToken,
  createCalendarEvent,
} from '@/lib/google-calendar'
import { sendBookingNotificationEmail } from '@/lib/email'
import { requestLeadEnrichment } from '@/lib/automation/events'

export type BookingConfig = {
  orgId: string
  orgName: string
  bookingTitle: string
  bookingDescription: string | null
  meetingDuration: number
  timezone: string
  availableDays: number[]
  startHour: number
  endHour: number
  bufferMinutes: number
  ownerName: string | null
}

export async function getBookingConfig(slug: string): Promise<BookingConfig | null> {
  const service = createServiceClient()

  const { data: org } = await service
    .from('organizations')
    .select('id, name')
    .eq('slug', slug)
    .single()

  if (!org) return null

  const { data: settings } = await service
    .from('booking_settings')
    .select('*')
    .eq('organization_id', org.id)
    .eq('is_enabled', true)
    .single()

  if (!settings) return null

  let ownerName: string | null = null
  if (settings.owner_profile_id) {
    const { data: ownerProfile } = await service
      .from('profiles')
      .select('full_name')
      .eq('id', settings.owner_profile_id)
      .single()
    ownerName = ownerProfile?.full_name ?? null
  }

  return {
    orgId: org.id,
    orgName: org.name,
    bookingTitle: settings.booking_title,
    bookingDescription: settings.booking_description,
    meetingDuration: settings.meeting_duration,
    timezone: settings.timezone,
    availableDays: settings.available_days,
    startHour: settings.start_hour,
    endHour: settings.end_hour,
    bufferMinutes: settings.buffer_minutes,
    ownerName,
  }
}

export type TimeSlot = {
  start: string
  end: string
  display: string
}

function toTzISOString(date: string, hour: number, min: number, timezone: string): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const dtStr = `${date}T${pad(hour)}:${pad(min)}:00`
  const utcGuess = new Date(dtStr + 'Z')
  const inTz = new Date(utcGuess.toLocaleString('en-US', { timeZone: timezone }))
  const offsetMs = inTz.getTime() - utcGuess.getTime()
  const local = new Date(`${dtStr}Z`)
  local.setTime(local.getTime() - offsetMs)
  return local.toISOString()
}

export async function getAvailableSlots(
  orgId: string,
  date: string
): Promise<{ slots: TimeSlot[]; error?: string }> {
  const service = createServiceClient()

  const { data: settings } = await service
    .from('booking_settings')
    .select('*')
    .eq('organization_id', orgId)
    .eq('is_enabled', true)
    .single()

  if (!settings) return { slots: [], error: 'Booking not available' }

  const { data: tokenRow } = await service
    .from('google_oauth_tokens')
    .select('*')
    .eq('organization_id', orgId)
    .single()

  if (!tokenRow) return { slots: [], error: 'Calendar not connected' }

  const accessToken = await getValidAccessToken(tokenRow, async (newToken, expiresAt) => {
    await service
      .from('google_oauth_tokens')
      .update({ access_token: newToken, token_expires_at: expiresAt })
      .eq('id', tokenRow.id)
  })

  const tz = settings.timezone
  const dayStartISO = toTzISOString(date, 0, 0, tz)
  const dayEndISO = toTzISOString(date, 23, 59, tz)
  const busySlots = await getFreeBusySlots(
    accessToken,
    tokenRow.calendar_email!,
    dayStartISO,
    dayEndISO
  )

  const duration = settings.meeting_duration
  const buffer = settings.buffer_minutes
  const slots: TimeSlot[] = []
  const now = new Date()

  for (let hour = settings.start_hour; hour < settings.end_hour; hour++) {
    for (let min = 0; min < 60; min += duration + buffer) {
      const slotStartISO = toTzISOString(date, hour, min, tz)
      const slotStartDate = new Date(slotStartISO)
      const slotEndDate = new Date(slotStartDate.getTime() + duration * 60 * 1000)

      const endHourInTz = Number(slotEndDate.toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: false }))
      const endMinInTz = Number(slotEndDate.toLocaleString('en-US', { timeZone: tz, minute: 'numeric' }))
      if (endHourInTz > settings.end_hour) continue
      if (endHourInTz === settings.end_hour && endMinInTz > 0) continue
      if (slotStartDate <= now) continue

      const isBusy = busySlots.some(busy => {
        const busyStart = new Date(busy.start)
        const busyEnd = new Date(busy.end)
        return slotStartDate < busyEnd && slotEndDate > busyStart
      })

      if (!isBusy) {
        const displayTime = slotStartDate.toLocaleString('en-US', {
          timeZone: tz,
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        })
        slots.push({
          start: slotStartISO,
          end: slotEndDate.toISOString(),
          display: displayTime,
        })
      }
    }
  }

  return { slots }
}

export type BookingFormData = {
  name: string
  email: string
  company: string
  phone?: string
  notes?: string
  slotStart: string
  slotEnd: string
}

export async function submitBooking(
  orgId: string,
  formData: BookingFormData
): Promise<{ success: boolean; meetLink?: string; error?: string }> {
  const service = createServiceClient()

  const { data: settings } = await service
    .from('booking_settings')
    .select('*')
    .eq('organization_id', orgId)
    .eq('is_enabled', true)
    .single()

  if (!settings) return { success: false, error: 'Booking not available' }

  const { data: tokenRow } = await service
    .from('google_oauth_tokens')
    .select('*')
    .eq('organization_id', orgId)
    .single()

  if (!tokenRow) return { success: false, error: 'Calendar not connected' }

  try {
    const accessToken = await getValidAccessToken(tokenRow, async (newToken, expiresAt) => {
      await service
        .from('google_oauth_tokens')
        .update({ access_token: newToken, token_expires_at: expiresAt })
        .eq('id', tokenRow.id)
    })

    const { data: org } = await service
      .from('organizations')
      .select('name')
      .eq('id', orgId)
      .single()

    const eventResult = await createCalendarEvent(accessToken, {
      summary: `Meeting with ${formData.name} — ${formData.company}`,
      description: [
        `Name: ${formData.name}`,
        `Email: ${formData.email}`,
        `Company: ${formData.company}`,
        formData.phone ? `Phone: ${formData.phone}` : '',
        formData.notes ? `Notes: ${formData.notes}` : '',
      ].filter(Boolean).join('\n'),
      startTime: formData.slotStart,
      endTime: formData.slotEnd,
      attendeeEmail: formData.email,
      timezone: settings.timezone,
    })

    let companyId: string | null = null
    const { data: existingCompany } = await service
      .from('companies')
      .select('id')
      .eq('organization_id', orgId)
      .ilike('name', formData.company)
      .maybeSingle()

    if (existingCompany) {
      companyId = existingCompany.id
    } else {
      const { data: newCompany } = await service
        .from('companies')
        .insert({
          organization_id: orgId,
          name: formData.company,
        })
        .select('id')
        .single()
      companyId = newCompany?.id ?? null
    }

    let contactId: string | null = null
    const { data: existingContact } = await service
      .from('contacts')
      .select('id')
      .eq('organization_id', orgId)
      .ilike('email', formData.email)
      .maybeSingle()

    if (existingContact) {
      contactId = existingContact.id
    } else {
      const { data: newContact } = await service
        .from('contacts')
        .insert({
          organization_id: orgId,
          company_id: companyId,
          full_name: formData.name,
          email: formData.email,
          phone: formData.phone ?? null,
        })
        .select('id')
        .single()
      contactId = newContact?.id ?? null
    }

    const { data: lead } = await service
      .from('leads')
      .insert({
        organization_id: orgId,
        company_id: companyId,
        contact_id: contactId,
        source: 'booking_page',
        status: 'contacted',
        pipeline_stage: 'meeting_booked',
        lead_quality: 'warm',
        lead_score: 50,
        booking_answers_json: {
          name: formData.name,
          email: formData.email,
          company: formData.company,
          phone: formData.phone ?? null,
          notes: formData.notes ?? null,
          booked_at: new Date().toISOString(),
        },
      })
      .select('id')
      .single()

    if (lead) {
      await service.from('meetings').insert({
        organization_id: orgId,
        lead_id: lead.id,
        title: `Meeting with ${formData.name} — ${formData.company}`,
        start_time: formData.slotStart,
        end_time: formData.slotEnd,
        meeting_url: eventResult.meetLink,
        calendar_event_id: eventResult.eventId,
        status: 'scheduled',
        created_by: settings.owner_profile_id,
      })

      await service.from('activity_logs').insert({
        organization_id: orgId,
        actor_profile_id: settings.owner_profile_id,
        entity_type: 'lead',
        entity_id: lead.id,
        action: 'created',
        after_json: {
          source: 'booking_page',
          pipeline_stage: 'meeting_booked',
          company: formData.company,
          contact: formData.name,
          meeting_time: formData.slotStart,
        },
      })

      // Hand off to n8n for enrichment. Non-blocking; no-ops if unconfigured.
      requestLeadEnrichment({
        organizationId: orgId,
        leadId: lead.id,
        fullName: formData.name,
        companyName: formData.company,
        website: null,
      })
    }

    let organizerEmail: string | null = tokenRow.calendar_email ?? null
    let organizerName = 'there'
    if (settings.owner_profile_id) {
      const { data: ownerProfile } = await service
        .from('profiles')
        .select('full_name, email')
        .eq('id', settings.owner_profile_id)
        .single()
      if (ownerProfile?.full_name) organizerName = ownerProfile.full_name
      if (ownerProfile?.email) organizerEmail = ownerProfile.email
    }

    if (organizerEmail) {
      const meetingDate = new Date(formData.slotStart)
      const meetingTime = meetingDate.toLocaleString('en-US', {
        timeZone: settings.timezone,
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      })

      sendBookingNotificationEmail(organizerEmail, organizerName, {
        guestName: formData.name,
        guestEmail: formData.email,
        company: formData.company,
        phone: formData.phone,
        notes: formData.notes,
        meetingTime,
        meetLink: eventResult.meetLink,
        orgName: org?.name ?? '',
      }).catch(err => console.error('Booking notification email error:', err))
    }

    return { success: true, meetLink: eventResult.meetLink }
  } catch (err) {
    console.error('Booking submission error:', err)
    return { success: false, error: 'Failed to create booking. Please try again.' }
  }
}
