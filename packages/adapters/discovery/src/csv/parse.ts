/**
 * RFC 4180 CSV parser with the deviations real files actually contain.
 *
 * Written by hand rather than pulled in as a dependency: the requirements are
 * narrow (a few thousand rows, no streaming) and the file comes from a user, so
 * the parser has to be forgiving in specific ways - Excel's semicolon delimiter,
 * a UTF-8 BOM, CRLF line endings, quoted fields containing the delimiter.
 */

export class CsvParseError extends Error {
  readonly line: number

  constructor(message: string, line: number) {
    super(`Line ${line}: ${message}`)
    this.name = "CsvParseError"
    this.line = line
  }
}

export interface ParseOptions {
  /** Detected automatically when omitted. */
  delimiter?: string
  /** Guards against a malicious or mistaken upload. */
  maxRows?: number
}

const DEFAULT_MAX_ROWS = 50_000

/**
 * Picks the delimiter by counting candidates outside quoted sections in the
 * header. Excel in a German locale writes semicolons, which would otherwise
 * parse as a single column and silently import nothing.
 */
export function detectDelimiter(sample: string): string {
  const firstLine = sample.split(/\r?\n/)[0] ?? ""
  const candidates = [",", ";", "\t", "|"]

  let best = ","
  let bestCount = 0

  for (const candidate of candidates) {
    let count = 0
    let inQuotes = false
    for (let i = 0; i < firstLine.length; i++) {
      const char = firstLine[i]
      if (char === '"') {
        inQuotes = !inQuotes
      } else if (char === candidate && !inQuotes) {
        count++
      }
    }
    if (count > bestCount) {
      bestCount = count
      best = candidate
    }
  }

  return best
}

/** Parses CSV text into rows of raw strings, including the header row. */
export function parseCsv(input: string, options: ParseOptions = {}): string[][] {
  // Excel prefixes UTF-8 files with a BOM, which would otherwise become part of
  // the first column name and break header matching.
  const text = input.replace(/^\uFEFF/, "")
  const delimiter = options.delimiter ?? detectDelimiter(text)
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS

  const rows: string[][] = []
  let field = ""
  let row: string[] = []
  let inQuotes = false
  let line = 1

  const endField = (): void => {
    row.push(field)
    field = ""
  }

  const endRow = (): void => {
    endField()
    // Skip blank lines rather than emitting a row of one empty string.
    if (row.length > 1 || row[0] !== "") rows.push(row)
    row = []
    if (rows.length > maxRows) {
      throw new CsvParseError(`more than ${maxRows} rows`, line)
    }
  }

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    const next = text[i + 1]

    if (inQuotes) {
      if (char === '"') {
        if (next === '"') {
          // Escaped quote inside a quoted field.
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        if (char === "\n") line++
        field += char
      }
      continue
    }

    if (char === '"' && field === "") {
      inQuotes = true
    } else if (char === delimiter) {
      endField()
    } else if (char === "\r" && next === "\n") {
      endRow()
      line++
      i++
    } else if (char === "\n" || char === "\r") {
      endRow()
      line++
    } else {
      field += char
    }
  }

  if (inQuotes) {
    throw new CsvParseError("unterminated quoted field", line)
  }
  // A file without a trailing newline still has a final row.
  if (field !== "" || row.length > 0) endRow()

  return rows
}

/**
 * Maps a header row onto our field names.
 *
 * Accepts German and English spellings because the file comes from whatever the
 * user exported - a CRM, Excel, or a colleague's hand-written list.
 */
const HEADER_ALIASES: Record<string, string[]> = {
  name: ["name", "firma", "firmenname", "unternehmen", "company", "company name", "betrieb"],
  website: ["website", "webseite", "web", "url", "homepage", "internet"],
  email: ["email", "e-mail", "mail", "e mail", "emailadresse", "e-mail-adresse"],
  phone: ["phone", "telefon", "tel", "telefonnummer", "phone number", "mobil", "handy"],
  street: ["street", "strasse", "straße", "adresse", "address", "anschrift"],
  houseNumber: ["housenumber", "hausnummer", "hnr", "nr", "house number"],
  postalCode: ["postalcode", "plz", "postleitzahl", "zip", "postal code", "zip code"],
  city: ["city", "stadt", "ort", "gemeinde", "town"],
  region: ["region", "bundesland", "state", "province"],
  country: ["country", "land", "staat"],
  externalId: ["id", "externalid", "external id", "kundennummer", "nummer", "reference"],
}

export interface HeaderMapping {
  /** Our field name -> column index. */
  columns: Record<string, number>
  /** Headers we could not interpret, kept for the raw payload. */
  unmapped: { header: string; index: number }[]
}

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ")
}

export function mapHeaders(headerRow: string[]): HeaderMapping {
  const columns: Record<string, number> = {}
  const unmapped: { header: string; index: number }[] = []

  headerRow.forEach((raw, index) => {
    const normalized = normalizeHeader(raw)
    const match = Object.entries(HEADER_ALIASES).find(([, aliases]) => aliases.includes(normalized))

    if (match && !(match[0] in columns)) {
      // First matching column wins: a file with two "name" columns should use
      // the leftmost rather than silently preferring the last.
      columns[match[0]] = index
    } else {
      unmapped.push({ header: raw.trim(), index })
    }
  })

  return { columns, unmapped }
}

/** Field names a CSV can supply, for error messages and documentation. */
export function knownCsvFields(): string[] {
  return Object.keys(HEADER_ALIASES)
}
