'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { getBatchStatus, getFailedRows } from './actions'
import Link from 'next/link'
import { csvRow } from '@/lib/csv'

type Props = {
  batchId: string
  onReset: () => void
}

type FailedRow = {
  row_number: number
  raw_data_json: Record<string, string>
  error_message: string
  status: string
}

export function SummaryStep({ batchId, onReset }: Props) {
  const [batch, setBatch] = useState<{
    file_name: string
    total_rows: number
    successful_rows: number
    failed_rows: number
    duplicate_rows: number
    completed_at: string
  } | null>(null)
  const [failedRows, setFailedRows] = useState<FailedRow[]>([])

  useEffect(() => {
    async function load() {
      const statusResult = await getBatchStatus(batchId)
      if ('batch' in statusResult && statusResult.batch) {
        setBatch(statusResult.batch)
      }

      const failedResult = await getFailedRows(batchId)
      if ('rows' in failedResult) {
        setFailedRows(failedResult.rows as FailedRow[])
      }
    }
    load()
  }, [batchId])

  function downloadFailedCSV() {
    if (failedRows.length === 0) return

    const allKeys = new Set<string>()
    failedRows.forEach(r => {
      Object.keys(r.raw_data_json).forEach(k => allKeys.add(k))
    })
    const keys = Array.from(allKeys)

    const headerLine = csvRow([...keys, 'row_number', 'status', 'error_message'])
    const dataLines = failedRows.map(r =>
      csvRow([
        ...keys.map(k => r.raw_data_json[k] ?? ''),
        r.row_number,
        r.status,
        r.error_message,
      ])
    )

    const csv = [headerLine, ...dataLines].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `failed-rows-${batchId.slice(0, 8)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (!batch) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border p-8 text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-500/10">
          <svg className="h-8 w-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="text-xl font-bold">Import Complete</h2>
        <p className="mt-1 text-sm text-muted-foreground">{batch.file_name}</p>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-4 gap-4">
        <div className="rounded-lg border p-4 text-center">
          <p className="text-3xl font-bold">{batch.total_rows}</p>
          <p className="text-sm text-muted-foreground">Total Rows</p>
        </div>
        <div className="rounded-lg border bg-green-500/5 p-4 text-center">
          <p className="text-3xl font-bold text-green-600">{batch.successful_rows}</p>
          <p className="text-sm text-muted-foreground">Imported</p>
        </div>
        <div className="rounded-lg border bg-yellow-500/5 p-4 text-center">
          <p className="text-3xl font-bold text-yellow-600">{batch.duplicate_rows}</p>
          <p className="text-sm text-muted-foreground">Duplicates</p>
        </div>
        <div className="rounded-lg border bg-red-500/5 p-4 text-center">
          <p className="text-3xl font-bold text-red-600">{batch.failed_rows}</p>
          <p className="text-sm text-muted-foreground">Failed</p>
        </div>
      </div>

      {/* Failed rows */}
      {failedRows.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="font-medium">Failed &amp; Skipped Rows</h3>
            <Button variant="outline" size="sm" onClick={downloadFailedCSV}>
              Download Failed Rows CSV
            </Button>
          </div>
          <div className="max-h-64 overflow-y-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="sticky top-0 border-b bg-muted/80 backdrop-blur">
                  <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Row</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Status</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Error</th>
                </tr>
              </thead>
              <tbody>
                {failedRows.slice(0, 50).map(r => (
                  <tr key={r.row_number} className="border-b last:border-0">
                    <td className="px-3 py-2 text-xs">{r.row_number}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                        r.status === 'skipped'
                          ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
                          : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                      }`}>
                        {r.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{r.error_message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-3">
        <Button onClick={onReset}>Import Another CSV</Button>
        <Link href="/leads">
          <Button variant="outline">View Leads</Button>
        </Link>
      </div>
    </div>
  )
}
