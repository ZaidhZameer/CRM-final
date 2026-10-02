// Company-name helpers for dedupe and display.

const SUFFIXES = new Set(['ltd', 'limited', 'llp', 'plc', 'lp', 'cic', 'cio', 'uk'])
const KEEP_UPPER = new Set(['UK', 'LLP', 'LTD', 'PLC', 'LP', 'CIC', 'IT', 'AI', 'GP', 'NHS'])

/** "HARBOR DENTAL LTD." -> "harbor dental"; used only to detect that a company already exists. */
export function normaliseCompanyName(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  while (words.length > 1 && SUFFIXES.has(words[words.length - 1])) words.pop()
  return words.join(' ')
}

/** Companies House stores names in capitals. "HARBOR DENTAL LTD" -> "Harbor Dental Ltd". */
export function displayCompanyName(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((w) => {
      const bare = w.replace(/[^A-Za-z]/g, '').toUpperCase()
      if (KEEP_UPPER.has(bare) && bare !== 'LTD' && bare !== 'PLC') return w.toUpperCase()
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
    })
    .join(' ')
}
