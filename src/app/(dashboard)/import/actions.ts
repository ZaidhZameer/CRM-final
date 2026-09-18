'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { scoreLeadRule } from '@/lib/scoring'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { sendImportCompleteEmail } from '@/lib/email'
import { emitLeadCreated } from '@/lib/automation/events'

const MAX_FILE_SIZE_FREE = 5 * 1024 * 1024 // 5MB
const MAX_ROWS_FREE = 1000

export async function createImportBatch(formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/sign-in')

  const fileName = formData.get('fileName') as string
  const fileSize = Number(formData.get('fileSize'))

  // Rate limit imports
  const rl = await RATE_LIMITS.import(user.id)
  if (!rl.success) return { error: `Too many imports. Try again in ${rl.resetIn}s.` }

  if (!fileName || !fileSize) {
    return { error: 'Missing file info' }
  }

  if (fileSize > MAX_FILE_SIZE_FREE) {
    return { error: `File too large. Free plan limit is ${MAX_FILE_SIZE_FREE / 1024 / 1024}MB.` }
  }

  if (!fileName.toLowerCase().endsWith('.csv')) {
    return { error: 'Only CSV files are supported' }
  }

  const service = createServiceClient()

  const { data: profile } = await service
    .from('profiles')
    .select('id, default_organization_id')
    .eq('user_id', user.id)
    .single()

  if (!profile?.default_organization_id) {
    return { error: 'No active organization' }
  }

  const orgId = profile.default_organization_id
  const batchId = crypto.randomUUID()
  const storagePath = `${orgId}/imports/${batchId}/original.csv`
  const idempotencyKey = `${orgId}-${fileName}-${fileSize}-${Date.now()}`

  const { error: batchError } = await service
    .from('csv_import_batches')
    .insert({
      id: batchId,
      organization_id: orgId,
      file_name: fileName,
      storage_path: storagePath,
      status: 'uploading',
      uploaded_by: profile.id,
      idempotency_key: idempotencyKey,
    })

  if (batchError) {
    return { error: 'Failed to create import batch' }
  }

  const { data: signedUrl, error: urlError } = await service
    .storage
    .from('csv-imports')
    .createSignedUploadUrl(storagePath)

  if (urlError || !signedUrl) {
    return { error: 'Failed to generate upload URL' }
  }

  return {
    batchId,
    signedUrl: signedUrl.signedUrl,
    token: signedUrl.token,
    path: signedUrl.path,
  }
}

export async function finalizeUpload(batchId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/sign-in')

  const service = createServiceClient()

  const { data: profile } = await service
    .from('profiles')
    .select('id, default_organization_id')
    .eq('user_id', user.id)
    .single()

  if (!profile?.default_organization_id) {
    return { error: 'No active organization' }
  }

  const { data: batch } = await service
    .from('csv_import_batches')
    .select('id, organization_id, storage_path, status')
    .eq('id', batchId)
    .eq('organization_id', profile.default_organization_id)
    .single()

  if (!batch) {
    return { error: 'Import batch not found' }
  }

  if (batch.status !== 'uploading') {
    return { error: 'Batch already processed' }
  }

  const { error } = await service
    .from('csv_import_batches')
    .update({ status: 'uploaded' })
    .eq('id', batchId)

  if (error) {
    return { error: 'Failed to update batch status' }
  }

  return { success: true }
}

export async function getPreviewRows(batchId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/sign-in')

  const service = createServiceClient()

  const { data: profile } = await service
    .from('profiles')
    .select('id, default_organization_id')
    .eq('user_id', user.id)
    .single()

  if (!profile?.default_organization_id) {
    return { error: 'No active organization' }
  }

  const { data: batch } = await service
    .from('csv_import_batches')
    .select('id, storage_path, organization_id')
    .eq('id', batchId)
    .eq('organization_id', profile.default_organization_id)
    .single()

  if (!batch) {
    return { error: 'Batch not found' }
  }

  const { data: fileData, error: downloadError } = await service
    .storage
    .from('csv-imports')
    .download(batch.storage_path)

  if (downloadError || !fileData) {
    return { error: 'Failed to download CSV' }
  }

  const text = await fileData.text()
  const lines = text.split('\n').filter(l => l.trim())
  const delimiter = detectDelimiter(lines[0])
  const previewLines = lines.slice(0, 201) // header + 200 rows

  return {
    headers: parseCSVLine(previewLines[0], delimiter),
    rows: previewLines.slice(1).map(line => parseCSVLine(line, delimiter)),
    totalLines: lines.length - 1,
    delimiter,
  }
}

function detectDelimiter(headerLine: string): string {
  const candidates = [',', '\t', ';', '|']
  let best = ','
  let bestCount = 0
  for (const d of candidates) {
    const count = headerLine.split(d).length
    if (count > bestCount) {
      bestCount = count
      best = d
    }
  }
  return best
}

function parseCSVLine(line: string, delimiter = ','): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (char === delimiter && !inQuotes) {
      result.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  result.push(current.trim())
  return result
}

export async function saveColumnMapping(batchId: string, mapping: Record<string, string>) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/sign-in')

  const service = createServiceClient()

  const { data: profile } = await service
    .from('profiles')
    .select('id, default_organization_id')
    .eq('user_id', user.id)
    .single()

  if (!profile?.default_organization_id) {
    return { error: 'No active organization' }
  }

  const { error } = await service
    .from('csv_import_batches')
    .update({
      column_mapping: mapping,
      status: 'parsing',
    })
    .eq('id', batchId)
    .eq('organization_id', profile.default_organization_id)

  if (error) {
    return { error: 'Failed to save mapping' }
  }

  return { success: true }
}

export async function startImportProcessing(batchId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/sign-in')

  const service = createServiceClient()

  const { data: profile } = await service
    .from('profiles')
    .select('id, default_organization_id')
    .eq('user_id', user.id)
    .single()

  if (!profile?.default_organization_id) {
    return { error: 'No active organization' }
  }

  const { data: batch } = await service
    .from('csv_import_batches')
    .select('id, storage_path, column_mapping, organization_id')
    .eq('id', batchId)
    .eq('organization_id', profile.default_organization_id)
    .single()

  if (!batch || !batch.column_mapping) {
    return { error: 'Batch not found or mapping not set' }
  }

  // Download and parse the full CSV
  const { data: fileData, error: downloadError } = await service
    .storage
    .from('csv-imports')
    .download(batch.storage_path)

  if (downloadError || !fileData) {
    return { error: 'Failed to download CSV for processing' }
  }

  const text = await fileData.text()
  const lines = text.split('\n').filter(l => l.trim())
  const delimiter = detectDelimiter(lines[0])
  const headers = parseCSVLine(lines[0], delimiter)
  const dataLines = lines.slice(1)
  const mapping = batch.column_mapping as Record<string, string>

  await service
    .from('csv_import_batches')
    .update({
      status: 'processing',
      total_rows: dataLines.length,
      started_at: new Date().toISOString(),
    })
    .eq('id', batchId)

  let successful = 0
  let failed = 0
  let duplicates = 0
  const CHUNK_SIZE = 100

  for (let i = 0; i < dataLines.length; i += CHUNK_SIZE) {
    const chunk = dataLines.slice(i, i + CHUNK_SIZE)
    const results = await processChunk(
      service,
      batch.organization_id,
      profile.id,
      batchId,
      headers,
      mapping,
      chunk,
      i + 1, // starting row number (1-based)
      delimiter,
    )
    successful += results.successful
    failed += results.failed
    duplicates += results.duplicates

    // Update progress
    await service
      .from('csv_import_batches')
      .update({
        successful_rows: successful,
        failed_rows: failed,
        duplicate_rows: duplicates,
      })
      .eq('id', batchId)
  }

  await service
    .from('csv_import_batches')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      successful_rows: successful,
      failed_rows: failed,
      duplicate_rows: duplicates,
    })
    .eq('id', batchId)

  // Send import-complete email (fire-and-forget)
  try {
    const { data: batchInfo } = await service
      .from('csv_import_batches')
      .select('file_name, total_rows')
      .eq('id', batchId)
      .single()

    const { data: authUser } = await service.auth.admin.getUserById(user.id)
    if (authUser?.user?.email) {
      const name = authUser.user.user_metadata?.full_name ?? authUser.user.email.split('@')[0]
      sendImportCompleteEmail(authUser.user.email, name, {
        total: batchInfo?.total_rows ?? 0,
        imported: successful,
        duplicates,
        failed,
        batchName: batchInfo?.file_name ?? 'import',
      }).catch(() => {})
    }
  } catch {}

  return { success: true, successful, failed, duplicates }
}

const FORMULA_CHARS = ['=', '+', '-', '@', '\t', '\r']

function sanitizeCell(value: string): string {
  if (value && FORMULA_CHARS.some(c => value.startsWith(c))) {
    return "'" + value
  }
  return value
}

async function processChunk(
  service: ReturnType<typeof createServiceClient>,
  orgId: string,
  profileId: string,
  batchId: string,
  headers: string[],
  mapping: Record<string, string>,
  lines: string[],
  startRow: number,
  delimiter: string,
) {
  let successful = 0
  let failed = 0
  let duplicates = 0

  for (let i = 0; i < lines.length; i++) {
    const rowNumber = startRow + i
    const values = parseCSVLine(lines[i], delimiter)
    const rawData: Record<string, string> = {}
    headers.forEach((h, idx) => {
      rawData[h] = values[idx] ?? ''
    })

    const mapped: Record<string, string> = {}
    for (const [csvCol, crmField] of Object.entries(mapping)) {
      if (crmField && crmField !== 'skip') {
        const idx = headers.indexOf(csvCol)
        if (idx !== -1 && values[idx]) {
          mapped[crmField] = sanitizeCell(values[idx].trim())
        }
      }
    }

    // Validate: need company_name or contact_name, AND email is required
    const hasIdentity = mapped.company_name || mapped.contact_name
    if (!hasIdentity || !mapped.email) {
      await service.from('csv_import_rows').insert({
        batch_id: batchId,
        row_number: rowNumber,
        raw_data_json: rawData,
        mapped_data_json: mapped,
        status: 'failed',
        error_message: !hasIdentity
          ? 'Missing company name or contact name'
          : 'Missing email — email is required for import',
      })
      failed++
      continue
    }

    // Dedupe check
    const isDuplicate = await checkDuplicate(service, orgId, mapped)
    if (isDuplicate) {
      await service.from('csv_import_rows').insert({
        batch_id: batchId,
        row_number: rowNumber,
        raw_data_json: rawData,
        mapped_data_json: mapped,
        status: 'skipped',
        error_message: 'Duplicate detected',
      })
      duplicates++
      continue
    }

    // Upsert company
    let companyId: string | null = null
    if (mapped.company_name) {
      const { data: existing } = await service
        .from('companies')
        .select('id')
        .eq('organization_id', orgId)
        .ilike('name', mapped.company_name)
        .is('deleted_at', null)
        .limit(1)
        .single()

      if (existing) {
        companyId = existing.id
      } else {
        const { data: newCompany } = await service
          .from('companies')
          .insert({
            organization_id: orgId,
            name: mapped.company_name,
            website: mapped.website || null,
            industry: mapped.industry || null,
            location: mapped.location || null,
            created_by: profileId,
          })
          .select('id')
          .single()
        companyId = newCompany?.id ?? null
      }
    }

    // Upsert contact — create if we have a name, email, or phone
    let contactId: string | null = null
    const hasContactData = mapped.contact_name || mapped.email || mapped.phone
    if (hasContactData) {
      if (mapped.email) {
        const { data: existing } = await service
          .from('contacts')
          .select('id')
          .eq('organization_id', orgId)
          .ilike('email', mapped.email)
          .is('deleted_at', null)
          .limit(1)
          .single()

        if (existing) {
          contactId = existing.id
        }
      }

      if (!contactId) {
        // Use contact name, or fall back to email prefix, or company name
        const contactName = mapped.contact_name
          || (mapped.email ? mapped.email.split('@')[0] : null)
          || mapped.company_name
          || 'Unknown'

        const { data: newContact } = await service
          .from('contacts')
          .insert({
            organization_id: orgId,
            company_id: companyId,
            full_name: contactName,
            email: mapped.email || null,
            phone: mapped.phone || null,
            job_title: mapped.job_title || null,
            linkedin_url: mapped.linkedin_url || null,
            created_by: profileId,
          })
          .select('id')
          .single()
        contactId = newContact?.id ?? null
      }
    }

    // Score lead using rule-based scorer
    const scoreResult = scoreLeadRule({
      email: mapped.email,
      phone: mapped.phone,
      website: mapped.website,
      job_title: mapped.job_title,
      linkedin_url: mapped.linkedin_url,
      industry: mapped.industry,
      location: mapped.location,
      company_name: mapped.company_name,
    })

    // Insert lead
    const { data: lead, error: leadError } = await service
      .from('leads')
      .insert({
        organization_id: orgId,
        company_id: companyId,
        contact_id: contactId,
        source: mapped.source || 'csv_import',
        status: 'new',
        lead_score: scoreResult.score,
        lead_quality: scoreResult.quality,
        ai_status: 'pending',
        created_by: profileId,
      })
      .select('id')
      .single()

    if (leadError || !lead) {
      await service.from('csv_import_rows').insert({
        batch_id: batchId,
        row_number: rowNumber,
        raw_data_json: rawData,
        mapped_data_json: mapped,
        status: 'failed',
        error_message: leadError?.message || 'Failed to create lead',
      })
      failed++
      continue
    }

    // Record successful import row
    await service.from('csv_import_rows').insert({
      batch_id: batchId,
      row_number: rowNumber,
      raw_data_json: rawData,
      mapped_data_json: mapped,
      status: 'imported',
      created_lead_id: lead.id,
    })

    // Hand off to n8n for enrichment. Non-blocking; no-ops if unconfigured.
    // NOTE: this fans out one POST per imported row. The adapter is expected to
    // queue; if a large CSV ever overwhelms it, batch here rather than in n8n.
    emitLeadCreated({
      organizationId: orgId,
      leadId: lead.id,
      fullName: mapped.contact_name || null,
      companyName: mapped.company_name || null,
      website: mapped.website || null,
    })

    // Activity log
    await service.from('activity_logs').insert({
      organization_id: orgId,
      actor_profile_id: profileId,
      entity_type: 'lead',
      entity_id: lead.id,
      action: 'imported',
      after_json: { source: 'csv_import', batch_id: batchId },
    })

    successful++
  }

  return { successful, failed, duplicates }
}

async function checkDuplicate(
  service: ReturnType<typeof createServiceClient>,
  orgId: string,
  mapped: Record<string, string>,
): Promise<boolean> {
  // Check by email first (strongest signal)
  if (mapped.email) {
    const { data } = await service
      .from('contacts')
      .select('id')
      .eq('organization_id', orgId)
      .ilike('email', mapped.email)
      .is('deleted_at', null)
      .limit(1)

    if (data && data.length > 0) return true
  }

  // Check by website
  if (mapped.website) {
    const { data } = await service
      .from('companies')
      .select('id')
      .eq('organization_id', orgId)
      .ilike('website', mapped.website)
      .is('deleted_at', null)
      .limit(1)

    if (data && data.length > 0) return true
  }

  // Check by phone
  if (mapped.phone) {
    const { data } = await service
      .from('contacts')
      .select('id')
      .eq('organization_id', orgId)
      .eq('phone', mapped.phone)
      .is('deleted_at', null)
      .limit(1)

    if (data && data.length > 0) return true
  }

  return false
}

export async function getBatchStatus(batchId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const service = createServiceClient()

  const { data: profile } = await service
    .from('profiles')
    .select('id, default_organization_id')
    .eq('user_id', user.id)
    .single()

  if (!profile?.default_organization_id) {
    return { error: 'No active organization' }
  }

  const { data: batch } = await service
    .from('csv_import_batches')
    .select('*')
    .eq('id', batchId)
    .eq('organization_id', profile.default_organization_id)
    .single()

  if (!batch) {
    return { error: 'Batch not found' }
  }

  return { batch }
}

export async function getFailedRows(batchId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const service = createServiceClient()

  const { data: profile } = await service
    .from('profiles')
    .select('id, default_organization_id')
    .eq('user_id', user.id)
    .single()

  if (!profile?.default_organization_id) {
    return { error: 'No active organization' }
  }

  const { data: rows } = await service
    .from('csv_import_rows')
    .select('row_number, raw_data_json, error_message, status')
    .eq('batch_id', batchId)
    .in('status', ['failed', 'skipped'])
    .order('row_number')

  return { rows: rows ?? [] }
}

export async function getImportHistory() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated', batches: [] }

  const service = createServiceClient()

  const { data: profile } = await service
    .from('profiles')
    .select('id, default_organization_id')
    .eq('user_id', user.id)
    .single()

  if (!profile?.default_organization_id) {
    return { error: 'No active organization', batches: [] }
  }

  const { data: batches } = await service
    .from('csv_import_batches')
    .select('id, file_name, status, total_rows, successful_rows, failed_rows, duplicate_rows, created_at, completed_at')
    .eq('organization_id', profile.default_organization_id)
    .order('created_at', { ascending: false })
    .limit(20)

  return { batches: batches ?? [] }
}
