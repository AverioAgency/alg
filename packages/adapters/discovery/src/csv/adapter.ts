import {
  type CostEstimate,
  type DiscoveryAdapter,
  type DiscoveryResult,
  type RawEntity,
  type SearchSpec,
  type TargetType,
} from "@alg/shared"
import { mapHeaders, parseCsv, type ParseOptions } from "./parse.js"

/**
 * Imports entities from a user-supplied CSV.
 *
 * Unlike the other adapters this one has no upstream service: the content is
 * handed in, which makes it the only adapter that works for every target type -
 * a list of companies, people or plain rows is whatever the user says it is.
 *
 * Rows that cannot be interpreted are reported rather than dropped. Silently
 * importing 340 of 500 rows is worse than saying which 160 failed and why.
 */

export interface CsvImportResult extends DiscoveryResult {
  /** Rows that could not be used, with the reason. */
  skipped: { line: number; reason: string }[]
  /** Headers the mapping did not recognize; useful feedback for the user. */
  unmappedHeaders: string[]
  totalRows: number
}

export interface CsvAdapterOptions {
  /** The file contents. */
  content: string
  targetType?: TargetType
  /** Overrides delimiter detection. */
  delimiter?: string
  maxRows?: number
  /** Identifies this import in company_sources. */
  importId?: string
}

export class CsvAdapter implements DiscoveryAdapter {
  readonly id = "csv"
  // A CSV can describe anything, so it is eligible for every target type.
  readonly targetTypes: TargetType[] = ["local_business", "company", "person", "list"]
  /** Filtering happens after parsing; the file has no query interface. */
  readonly supports: string[] = []

  private readonly content: string
  private readonly targetType: TargetType
  private readonly parseOptions: ParseOptions
  private readonly importId: string

  constructor(options: CsvAdapterOptions) {
    this.content = options.content
    this.targetType = options.targetType ?? "company"
    this.parseOptions = {
      ...(options.delimiter ? { delimiter: options.delimiter } : {}),
      ...(options.maxRows ? { maxRows: options.maxRows } : {}),
    }
    this.importId = options.importId ?? "manual"
  }

  estimateCost(spec: SearchSpec): CostEstimate {
    // Counting lines is cheap and gives an honest number rather than a guess.
    const lines = this.content.split(/\r?\n/).filter((l) => l.trim().length > 0).length
    const rows = Math.max(0, lines - 1)

    return {
      estimatedEntities: spec.limit ? Math.min(spec.limit, rows) : rows,
      estimatedCostEur: 0,
      estimatedSeconds: 1,
      degraded: false,
      notes: ["CSV-Import verursacht keine Kosten und keine externen Anfragen."],
    }
  }

  async search(spec: SearchSpec): Promise<DiscoveryResult> {
    const result = this.import(spec.limit)
    return { entities: result.entities }
  }

  /** Full result including diagnostics, for the import endpoint. */
  import(limit?: number): CsvImportResult {
    const rows = parseCsv(this.content, this.parseOptions)

    if (rows.length === 0) {
      return { entities: [], skipped: [], unmappedHeaders: [], totalRows: 0 }
    }

    const [headerRow = [], ...dataRows] = rows
    const mapping = mapHeaders(headerRow)

    if (mapping.columns.name === undefined) {
      throw new Error(
        `Die CSV braucht eine Spalte mit dem Firmennamen. Erkannte Spalten: ${headerRow.join(", ")}`
      )
    }

    const entities: RawEntity[] = []
    const skipped: { line: number; reason: string }[] = []

    for (const [index, row] of dataRows.entries()) {
      // +2: one for the header, one because humans count from 1.
      const line = index + 2

      if (limit !== undefined && entities.length >= limit) break

      const value = (field: string): string | null => {
        const column = mapping.columns[field]
        if (column === undefined) return null
        const raw = row[column]
        if (raw === undefined) return null
        const trimmed = raw.trim()
        return trimmed.length > 0 ? trimmed : null
      }

      const name = value("name")
      if (!name) {
        skipped.push({ line, reason: "kein Firmenname" })
        continue
      }

      const entity: RawEntity = {
        source: "csv",
        sourceId: value("externalId") ?? `${this.importId}:${line}`,
        targetType: this.targetType,
        name,
        raw: Object.fromEntries(headerRow.map((header, i) => [header, row[i] ?? ""])),
      }

      const street = value("street")
      const postalCode = value("postalCode")
      const city = value("city")
      if (street || postalCode || city) {
        entity.address = {
          street,
          house_number: value("houseNumber"),
          postal_code: postalCode,
          city,
          region: value("region"),
          country: normalizeCountry(value("country")),
        }
      }

      const website = value("website")
      if (website) entity.website = website

      const phone = value("phone")
      if (phone) entity.phone = phone

      const email = value("email")
      if (email) entity.email = email

      entities.push(entity)
    }

    return {
      entities,
      skipped,
      unmappedHeaders: mapping.unmapped.map((u) => u.header),
      totalRows: dataRows.length,
    }
  }
}

/**
 * Accepts both a two-letter code and a spelled-out country name for the handful
 * that actually appear in these files.
 */
const COUNTRY_NAMES: Record<string, string> = {
  österreich: "AT",
  oesterreich: "AT",
  austria: "AT",
  deutschland: "DE",
  germany: "DE",
  schweiz: "CH",
  switzerland: "CH",
}

function normalizeCountry(value: string | null): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase()
  return COUNTRY_NAMES[trimmed.toLowerCase()] ?? null
}
