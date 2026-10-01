'use client'

import { useState, useEffect, useCallback } from 'react'
import { Calendar, Clock, Building2, User, Mail, Phone, MessageSquare, CheckCircle2, ChevronLeft, ChevronRight, Video } from 'lucide-react'
import { getBookingConfig, getAvailableSlots, submitBooking, type BookingConfig, type TimeSlot, type BookingFormData } from './actions'
import { useParams } from 'next/navigation'

type Step = 'form' | 'calendar' | 'confirm' | 'success'

export default function BookingPage() {
  const params = useParams()
  const slug = params.slug as string

  const [config, setConfig] = useState<BookingConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  const [step, setStep] = useState<Step>('form')
  const [formData, setFormData] = useState({ name: '', email: '', company: '', phone: '', notes: '' })
  const [formErrors, setFormErrors] = useState<Record<string, string>>({})

  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [slots, setSlots] = useState<TimeSlot[]>([])
  const [slotsLoading, setSlotsLoading] = useState(false)
  const [selectedSlot, setSelectedSlot] = useState<TimeSlot | null>(null)

  const [submitting, setSubmitting] = useState(false)
  const [meetLink, setMeetLink] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const [calMonth, setCalMonth] = useState(new Date().getMonth())
  const [calYear, setCalYear] = useState(new Date().getFullYear())

  useEffect(() => {
    getBookingConfig(slug).then(c => {
      if (!c) setNotFound(true)
      else setConfig(c)
      setLoading(false)
    })
  }, [slug])

  const loadSlots = useCallback(async (date: string) => {
    if (!config) return
    setSlotsLoading(true)
    setSelectedSlot(null)
    const result = await getAvailableSlots(config.orgId, date)
    setSlots(result.slots)
    setSlotsLoading(false)
  }, [config])

  useEffect(() => {
    if (selectedDate) loadSlots(selectedDate)
  }, [selectedDate, loadSlots])

  function validateForm(): boolean {
    const errors: Record<string, string> = {}
    if (!formData.name.trim()) errors.name = 'Name is required'
    if (!formData.email.trim()) errors.email = 'Email is required'
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) errors.email = 'Invalid email'
    if (!formData.company.trim()) errors.company = 'Company is required'
    else if (/^https?:\/\//i.test(formData.company.trim())) errors.company = 'Please enter a company name, not a URL'
    setFormErrors(errors)
    return Object.keys(errors).length === 0
  }

  function handleFormSubmit() {
    if (validateForm()) setStep('calendar')
  }

  async function handleBooking() {
    if (!config || !selectedSlot) return
    setSubmitting(true)
    setSubmitError(null)

    const data: BookingFormData = {
      name: formData.name.trim(),
      email: formData.email.trim().toLowerCase(),
      company: formData.company.trim(),
      phone: formData.phone.trim() || undefined,
      notes: formData.notes.trim() || undefined,
      slotStart: selectedSlot.start,
      slotEnd: selectedSlot.end,
    }

    const result = await submitBooking(config.orgId, data)
    setSubmitting(false)

    if (result.success) {
      setMeetLink(result.meetLink ?? null)
      setStep('success')
    } else {
      setSubmitError(result.error ?? 'Something went wrong')
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950">
        <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-white/20 border-t-white" />
      </div>
    )
  }

  if (notFound || !config) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-950 text-white">
        <h1 className="text-2xl font-bold">Booking Not Available</h1>
        <p className="mt-2 text-zinc-400">This booking page doesn&apos;t exist or is not active.</p>
      </div>
    )
  }

  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const today = new Date()
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const firstDay = new Date(calYear, calMonth, 1).getDay()
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate()

  function isAvailableDay(day: number): boolean {
    const date = new Date(calYear, calMonth, day)
    const dateStr = `${calYear}-${String(calMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    if (dateStr < todayStr) return false
    const dow = date.getDay()
    return config!.availableDays.includes(dow)
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 p-4">
      <div className="w-full max-w-2xl">
        {/* Header */}
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-violet-600">
            <Calendar className="h-6 w-6 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white">{config.bookingTitle}</h1>
          <p className="mt-1 text-sm text-zinc-400">
            {config.ownerName ? `${config.ownerName} · ` : ''}{config.orgName}
          </p>
          {config.bookingDescription && (
            <p className="mt-2 text-sm text-zinc-500">{config.bookingDescription}</p>
          )}
          <div className="mt-3 flex items-center justify-center gap-3 text-xs text-zinc-500">
            <span className="flex items-center gap-1"><Clock className="h-3.5 w-3.5" />{config.meetingDuration} min</span>
            <span className="flex items-center gap-1"><Video className="h-3.5 w-3.5" />Google Meet</span>
          </div>
        </div>

        {/* Steps indicator */}
        <div className="mb-6 flex items-center justify-center gap-2">
          {(['form', 'calendar', 'confirm'] as const).map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium transition-colors ${
                step === s ? 'bg-blue-600 text-white' :
                (['form', 'calendar', 'confirm'].indexOf(step) > i || step === 'success') ? 'bg-emerald-600 text-white' :
                'bg-zinc-800 text-zinc-500'
              }`}>
                {(['form', 'calendar', 'confirm'].indexOf(step) > i || step === 'success') ? '✓' : i + 1}
              </div>
              {i < 2 && <div className={`h-px w-8 ${(['form', 'calendar', 'confirm'].indexOf(step) > i || step === 'success') ? 'bg-emerald-600' : 'bg-zinc-800'}`} />}
            </div>
          ))}
        </div>

        {/* Step 1: Form */}
        {step === 'form' && (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
            <h2 className="mb-4 text-lg font-semibold text-white">Your Details</h2>
            <div className="space-y-4">
              <div>
                <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-zinc-300">
                  <User className="h-3.5 w-3.5 text-zinc-500" />Full Name <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={e => setFormData(f => ({ ...f, name: e.target.value }))}
                  placeholder="John Doe"
                  className={`h-10 w-full rounded-lg border bg-zinc-800/50 px-3 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/50 ${formErrors.name ? 'border-red-500/50' : 'border-zinc-700'}`}
                />
                {formErrors.name && <p className="mt-1 text-xs text-red-400">{formErrors.name}</p>}
              </div>

              <div>
                <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-zinc-300">
                  <Mail className="h-3.5 w-3.5 text-zinc-500" />Email <span className="text-red-400">*</span>
                </label>
                <input
                  type="email"
                  value={formData.email}
                  onChange={e => setFormData(f => ({ ...f, email: e.target.value }))}
                  placeholder="john@company.com"
                  className={`h-10 w-full rounded-lg border bg-zinc-800/50 px-3 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/50 ${formErrors.email ? 'border-red-500/50' : 'border-zinc-700'}`}
                />
                {formErrors.email && <p className="mt-1 text-xs text-red-400">{formErrors.email}</p>}
              </div>

              <div>
                <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-zinc-300">
                  <Building2 className="h-3.5 w-3.5 text-zinc-500" />Company <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={formData.company}
                  onChange={e => setFormData(f => ({ ...f, company: e.target.value }))}
                  placeholder="Acme Inc."
                  className={`h-10 w-full rounded-lg border bg-zinc-800/50 px-3 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/50 ${formErrors.company ? 'border-red-500/50' : 'border-zinc-700'}`}
                />
                {formErrors.company && <p className="mt-1 text-xs text-red-400">{formErrors.company}</p>}
              </div>

              <div>
                <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-zinc-300">
                  <Phone className="h-3.5 w-3.5 text-zinc-500" />Phone <span className="text-zinc-600 text-xs">(optional)</span>
                </label>
                <input
                  type="tel"
                  value={formData.phone}
                  onChange={e => setFormData(f => ({ ...f, phone: e.target.value }))}
                  placeholder="+91 98765 43210"
                  className="h-10 w-full rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                />
              </div>

              <div>
                <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-zinc-300">
                  <MessageSquare className="h-3.5 w-3.5 text-zinc-500" />What would you like to discuss? <span className="text-zinc-600 text-xs">(optional)</span>
                </label>
                <textarea
                  value={formData.notes}
                  onChange={e => setFormData(f => ({ ...f, notes: e.target.value }))}
                  placeholder="Tell us briefly about your needs..."
                  rows={3}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 py-2 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/50 resize-none"
                />
              </div>

              <button
                onClick={handleFormSubmit}
                className="h-10 w-full rounded-lg bg-gradient-to-r from-blue-600 to-violet-600 text-sm font-medium text-white transition-opacity hover:opacity-90"
              >
                Choose a Time
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Calendar + Slots */}
        {step === 'calendar' && (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
            <button onClick={() => setStep('form')} className="mb-4 flex items-center gap-1 text-xs text-zinc-400 hover:text-white transition-colors">
              <ChevronLeft className="h-3.5 w-3.5" /> Back to details
            </button>

            <h2 className="mb-4 text-lg font-semibold text-white">Pick a Date & Time</h2>

            <div className="flex gap-5">
              {/* Mini calendar */}
              <div className="flex-1">
                <div className="flex items-center justify-between mb-3">
                  <button
                    aria-label="Previous month"
                    onClick={() => { if (calMonth === 0) { setCalMonth(11); setCalYear(y => y - 1) } else setCalMonth(m => m - 1) }}
                    className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <span className="text-sm font-medium text-white">{MONTH_NAMES[calMonth]} {calYear}</span>
                  <button
                    aria-label="Next month"
                    onClick={() => { if (calMonth === 11) { setCalMonth(0); setCalYear(y => y + 1) } else setCalMonth(m => m + 1) }}
                    className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>

                <div className="grid grid-cols-7 gap-1">
                  {DAY_NAMES.map(d => (
                    <div key={d} className="py-1 text-center text-[10px] font-medium text-zinc-600">{d}</div>
                  ))}
                  {Array.from({ length: firstDay }).map((_, i) => (
                    <div key={`e-${i}`} />
                  ))}
                  {Array.from({ length: daysInMonth }).map((_, i) => {
                    const day = i + 1
                    const dateStr = `${calYear}-${String(calMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
                    const available = isAvailableDay(day)
                    const selected = dateStr === selectedDate

                    return (
                      <button
                        key={day}
                        disabled={!available}
                        onClick={() => setSelectedDate(dateStr)}
                        className={`flex h-9 w-9 items-center justify-center rounded-lg text-xs font-medium transition-all ${
                          selected ? 'bg-blue-600 text-white' :
                          available ? 'text-zinc-300 hover:bg-zinc-800' :
                          'text-zinc-700 cursor-not-allowed'
                        }`}
                      >
                        {day}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Time slots */}
              <div className="w-44 shrink-0">
                <h3 className="mb-2 text-sm font-medium text-zinc-300">
                  {selectedDate
                    ? new Date(selectedDate + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
                    : 'Select a date'}
                </h3>

                {!selectedDate ? (
                  <p className="text-xs text-zinc-600">Pick a date to see times</p>
                ) : slotsLoading ? (
                  <div className="flex items-center gap-2 text-xs text-zinc-500">
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-400" />
                    Loading...
                  </div>
                ) : slots.length === 0 ? (
                  <p className="text-xs text-zinc-500">No available times</p>
                ) : (
                  <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
                    {slots.map(slot => (
                      <button
                        key={slot.start}
                        onClick={() => setSelectedSlot(slot)}
                        className={`w-full rounded-lg border px-3 py-2 text-left text-xs font-medium transition-all ${
                          selectedSlot?.start === slot.start
                            ? 'border-blue-500 bg-blue-600/20 text-blue-400'
                            : 'border-zinc-700 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800'
                        }`}
                      >
                        {slot.display}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <button
              disabled={!selectedSlot}
              onClick={() => setStep('confirm')}
              className="mt-5 h-10 w-full rounded-lg bg-gradient-to-r from-blue-600 to-violet-600 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Confirm Booking
            </button>
          </div>
        )}

        {/* Step 3: Confirmation */}
        {step === 'confirm' && selectedSlot && (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
            <button onClick={() => setStep('calendar')} className="mb-4 flex items-center gap-1 text-xs text-zinc-400 hover:text-white transition-colors">
              <ChevronLeft className="h-3.5 w-3.5" /> Change time
            </button>

            <h2 className="mb-5 text-lg font-semibold text-white">Confirm Your Booking</h2>

            <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-800/30 p-4">
              <div className="flex items-center gap-3">
                <User className="h-4 w-4 text-zinc-500" />
                <div>
                  <p className="text-xs text-zinc-500">Name</p>
                  <p className="text-sm text-white">{formData.name}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Mail className="h-4 w-4 text-zinc-500" />
                <div>
                  <p className="text-xs text-zinc-500">Email</p>
                  <p className="text-sm text-white">{formData.email}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Building2 className="h-4 w-4 text-zinc-500" />
                <div>
                  <p className="text-xs text-zinc-500">Company</p>
                  <p className="text-sm text-white">{formData.company}</p>
                </div>
              </div>
              <div className="h-px bg-zinc-800" />
              <div className="flex items-center gap-3">
                <Calendar className="h-4 w-4 text-zinc-500" />
                <div>
                  <p className="text-xs text-zinc-500">Date & Time</p>
                  <p className="text-sm text-white">
                    {new Date(selectedSlot.start).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
                    {' at '}{selectedSlot.display}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Clock className="h-4 w-4 text-zinc-500" />
                <div>
                  <p className="text-xs text-zinc-500">Duration</p>
                  <p className="text-sm text-white">{config.meetingDuration} minutes</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Video className="h-4 w-4 text-zinc-500" />
                <div>
                  <p className="text-xs text-zinc-500">Meeting Type</p>
                  <p className="text-sm text-white">Google Meet (link will be sent to your email)</p>
                </div>
              </div>
            </div>

            {submitError && (
              <div className="mt-4 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-400">
                {submitError}
              </div>
            )}

            <button
              onClick={handleBooking}
              disabled={submitting}
              className="mt-5 h-10 w-full rounded-lg bg-gradient-to-r from-blue-600 to-violet-600 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {submitting ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  Booking...
                </span>
              ) : 'Book Meeting'}
            </button>

            <p className="mt-3 text-center text-xs text-zinc-500">
              We&apos;ll use your details to reply to your enquiry. We may also research publicly available information about
              your business to make our reply relevant, and send a few follow-up emails about your enquiry. You can opt out at
              any time by replying &apos;stop&apos; or emailing us. See our{' '}
              <a href="/privacy" className="underline hover:text-zinc-300">privacy notice</a>.
            </p>
          </div>
        )}

        {/* Step 4: Success */}
        {step === 'success' && (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-8 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10">
              <CheckCircle2 className="h-8 w-8 text-emerald-500" />
            </div>
            <h2 className="text-xl font-bold text-white">Meeting Booked!</h2>
            <p className="mt-2 text-sm text-zinc-400">
              A calendar invite has been sent to <strong className="text-zinc-300">{formData.email}</strong>
            </p>

            {selectedSlot && (
              <div className="mt-4 inline-flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-800/50 px-4 py-2.5 text-sm text-zinc-300">
                <Calendar className="h-4 w-4 text-blue-400" />
                {new Date(selectedSlot.start).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                {' at '}{selectedSlot.display}
                <span className="text-zinc-600">·</span>
                <Clock className="h-3.5 w-3.5 text-zinc-500" />
                {config.meetingDuration} min
              </div>
            )}

            {meetLink && (
              <div className="mt-4">
                <a
                  href={meetLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
                >
                  <Video className="h-4 w-4" />
                  Join Google Meet
                </a>
              </div>
            )}

            <p className="mt-6 text-xs text-zinc-600">
              Powered by {config.orgName}
            </p>
          </div>
        )}

        {/* Footer */}
        <p className="mt-6 text-center text-xs text-zinc-700">
          Powered by LeadFlow CRM
        </p>
      </div>
    </div>
  )
}
