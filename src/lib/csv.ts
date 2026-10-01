// Values a spreadsheet would run as a formula when a CSV is opened.
const FORMULA_START = /^[=+\-@\t\r]/

/**
 * One CSV cell, safe to open in Excel/Sheets: a leading =, +, -, @, tab or CR is neutralised
 * with an apostrophe prefix, and fields containing commas, quotes or line breaks are quoted.
 * Do this at export time only, so stored values (e.g. +44 phone numbers) stay untouched.
 */
export function csvSafe(value: unknown): string {
  let s = value == null ? '' : String(value)
  if (FORMULA_START.test(s)) s = "'" + s
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`
  return s
}

export function csvRow(values: unknown[]): string {
  return values.map(csvSafe).join(',')
}
