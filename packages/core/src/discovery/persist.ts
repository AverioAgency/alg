import { and, eq, isNotNull, or, sql, type SQL } from "drizzle-orm"
import { companies, companySources, withWorkspace, type Database } from "@alg/db"
import { type RawEntity } from "@alg/shared"
import {
  DEFAULT_TRIGRAM_THRESHOLD,
  findDuplicate,
  type DedupeCandidate,
  type DedupeMatch,
} from "./dedupe.js"
import {
  cleanString,
  normalizeCompanyName,
  normalizeCountryCode,
  normalizeDomain,
  normalizeEmail,
  normalizePhone,
  normalizePostalCode,
  normalizeWebsite,
} from "./normalize.js"

/**
 * Turns RawEntities into rows, running the dedupe cascade against what is already
 * stored.
 *
 * The in-memory cascade only sees the current batch. Here the candidate set comes
 * from the database, and it is narrowed with SQL first: loading every company in
 * a workspace to compare in JavaScript would not survive the first real dataset.
 * The narrowing predicate mirrors the cascade exactly - same source id, same
 * domain, same phone, or a trigram match on name within the same postcode.
 */

export interface PersistOptions {
  workspaceId: string
  runId?: string
  db: Database
  trigramThreshold?: number
  /** Injectable for deterministic tests. */
  now?: () => Date
}

export interface PersistResult {
  created: number
  duplicates: number
  /** Per entity, what happened - the run report is built from this. */
  outcomes: {
    name: string
    companyId: string
    status: "created" | "duplicate"
    stage?: DedupeMatch["stage"]
    confidence?: number
  }[]
}

/** Normalized shape of an incoming entity, ready to be written. */
interface NormalizedEntity {
  name: string
  nameNormalized: string | null
  domain: string | null
  website: string | null
  phone: string | null
  email: string | null
  street: string | null
  houseNumber: string | null
  postalCode: string | null
  city: string | null
  region: string | null
  countryCode: string | null
  lat: number | null
  lon: number | null
  targetType: string
  source: string
  externalId: string | null
  raw: Record<string, unknown> | null
}

export function normalizeEntity(entity: RawEntity): NormalizedEntity | null {
  const name = cleanString(entity.name)
  if (!name) return null

  const address = entity.address ?? null
  const countryCode = normalizeCountryCode(address?.country ?? null)

  // Country decides how a national phone number is interpreted; without one, AT
  // is the sensible default for this project rather than a silent guess.
  const phoneCountry = countryCode === "DE" || countryCode === "CH" ? countryCode : ("AT" as const)

  return {
    name,
    nameNormalized: normalizeCompanyName(name),
    domain: normalizeDomain(entity.website ?? null),
    website: normalizeWebsite(entity.website ?? null),
    phone: normalizePhone(entity.phone ?? null, phoneCountry),
    email: normalizeEmail(entity.email ?? null),
    street: cleanString(address?.street ?? null),
    houseNumber: cleanString(address?.house_number ?? null),
    postalCode: normalizePostalCode(address?.postal_code ?? null),
    city: cleanString(address?.city ?? null),
    region: cleanString(address?.region ?? null),
    countryCode,
    lat: entity.geo?.lat ?? null,
    lon: entity.geo?.lon ?? null,
    targetType: entity.targetType,
    source: entity.source,
    externalId: entity.sourceId ?? null,
    raw: entity.raw ?? null,
  }
}

/**
 * Persists a batch, deduplicating against the database.
 *
 * Entities are processed one at a time on purpose: entity N has to be able to
 * match against entity N-1 from the same batch, which a bulk insert would miss.
 */
export async function persistEntities(
  entities: readonly RawEntity[],
  options: PersistOptions
): Promise<PersistResult> {
  const threshold = options.trigramThreshold ?? DEFAULT_TRIGRAM_THRESHOLD
  const now = options.now ?? (() => new Date())
  const result: PersistResult = { created: 0, duplicates: 0, outcomes: [] }

  for (const entity of entities) {
    const normalized = normalizeEntity(entity)
    if (!normalized) continue

    const incoming: DedupeCandidate = {
      id: "incoming",
      sourceId: normalized.source,
      externalId: normalized.externalId,
      domain: normalized.domain,
      phone: normalized.phone,
      nameNormalized: normalized.nameNormalized,
      postalCode: normalized.postalCode,
    }

    const existing = await findCandidates(normalized, options, threshold)
    const match = findDuplicate(incoming, existing, { trigramThreshold: threshold })

    if (match) {
      await recordSighting(match.candidateId, normalized, options, now())
      result.duplicates++
      result.outcomes.push({
        name: normalized.name,
        companyId: match.candidateId,
        status: "duplicate",
        stage: match.stage,
        confidence: match.confidence,
      })
      continue
    }

    const companyId = await insertCompany(normalized, options, now())
    result.created++
    result.outcomes.push({ name: normalized.name, companyId, status: "created" })
  }

  return result
}

/**
 * Narrows the comparison set in SQL.
 *
 * Only rows that could plausibly match are loaded - the same predicate the
 * cascade would apply, expressed as a WHERE clause so Postgres can use the
 * indexes (including the trigram GIN index) instead of a sequential scan.
 */
async function findCandidates(
  normalized: NormalizedEntity,
  options: PersistOptions,
  threshold: number
): Promise<DedupeCandidate[]> {
  const predicates: SQL[] = []

  if (normalized.domain) {
    predicates.push(eq(companies.domain, normalized.domain))
  }
  if (normalized.phone) {
    predicates.push(eq(companies.phone, normalized.phone))
  }
  if (normalized.nameNormalized && normalized.postalCode) {
    // similarity() uses the pg_trgm GIN index; the postcode equality keeps the
    // candidate set small even in a workspace with many similar names.
    // Written as a single fragment because and() is typed as possibly-undefined
    // for the empty-argument case, which cannot occur here.
    predicates.push(
      sql`${eq(companies.postalCode, normalized.postalCode)} and ${isNotNull(
        companies.nameNormalized
      )} and similarity(${companies.nameNormalized}, ${normalized.nameNormalized}) >= ${threshold}`
    )
  }

  const rows = await withWorkspace(
    { workspaceId: options.workspaceId },
    async ({ tx, scope }) => {
      // Stage 1 matches on the source id, which lives in company_sources rather
      // than on the company row, so it needs its own lookup.
      const bySource = normalized.externalId
        ? await tx
            .select({
              id: companySources.companyId,
              sourceId: companySources.sourceId,
              externalId: companySources.externalId,
            })
            .from(companySources)
            .where(
              scope(
                companySources,
                and(
                  eq(companySources.sourceId, normalized.source),
                  eq(companySources.externalId, normalized.externalId)
                )
              )
            )
            .limit(1)
        : []

      if (bySource.length > 0) {
        const hit = bySource[0]
        return [
          {
            id: hit?.id ?? "",
            sourceId: hit?.sourceId ?? null,
            externalId: hit?.externalId ?? null,
          },
        ] satisfies DedupeCandidate[]
      }

      if (predicates.length === 0) return [] satisfies DedupeCandidate[]

      const found = await tx
        .select({
          id: companies.id,
          domain: companies.domain,
          phone: companies.phone,
          nameNormalized: companies.nameNormalized,
          postalCode: companies.postalCode,
        })
        .from(companies)
        .where(scope(companies, or(...predicates)))
        .limit(50)

      return found.map((row) => ({
        id: row.id,
        sourceId: null,
        externalId: null,
        domain: row.domain,
        phone: row.phone,
        nameNormalized: row.nameNormalized,
        postalCode: row.postalCode,
      })) satisfies DedupeCandidate[]
    },
    options.db
  )

  return rows
}

async function insertCompany(
  normalized: NormalizedEntity,
  options: PersistOptions,
  at: Date
): Promise<string> {
  return withWorkspace(
    { workspaceId: options.workspaceId },
    async ({ tx, values }) => {
      const [row] = await tx
        .insert(companies)
        .values(
          values({
            targetType: normalized.targetType,
            name: normalized.name,
            nameNormalized: normalized.nameNormalized,
            domain: normalized.domain,
            website: normalized.website,
            phone: normalized.phone,
            email: normalized.email,
            street: normalized.street,
            houseNumber: normalized.houseNumber,
            postalCode: normalized.postalCode,
            city: normalized.city,
            region: normalized.region,
            countryCode: normalized.countryCode,
            lat: normalized.lat,
            lon: normalized.lon,
            firstSeenRunId: options.runId ?? null,
            lastSeenAt: at,
          })
        )
        .returning({ id: companies.id })

      const companyId = row?.id
      if (!companyId) throw new Error("Insert returned no company id")

      await tx
        .insert(companySources)
        .values(
          values({
            companyId,
            sourceId: normalized.source,
            externalId: normalized.externalId,
            rawPayload: normalized.raw,
            fetchedAt: at,
          })
        )
        .onConflictDoNothing()

      return companyId
    },
    options.db
  )
}

/**
 * Records that a known company was seen again, and fills in fields that were
 * previously unknown.
 *
 * Existing values are never overwritten: the first source to supply a phone
 * number is usually the more reliable one, and silently replacing it would make
 * the data depend on the order adapters happen to run in.
 */
async function recordSighting(
  companyId: string,
  normalized: NormalizedEntity,
  options: PersistOptions,
  at: Date
): Promise<void> {
  await withWorkspace(
    { workspaceId: options.workspaceId },
    async ({ tx, scope, values }) => {
      await tx
        .update(companies)
        .set({
          lastSeenAt: at,
          updatedAt: at,
          // COALESCE keeps whatever is already there and only fills gaps.
          domain: sql`coalesce(${companies.domain}, ${normalized.domain})`,
          website: sql`coalesce(${companies.website}, ${normalized.website})`,
          phone: sql`coalesce(${companies.phone}, ${normalized.phone})`,
          email: sql`coalesce(${companies.email}, ${normalized.email})`,
          street: sql`coalesce(${companies.street}, ${normalized.street})`,
          houseNumber: sql`coalesce(${companies.houseNumber}, ${normalized.houseNumber})`,
          postalCode: sql`coalesce(${companies.postalCode}, ${normalized.postalCode})`,
          city: sql`coalesce(${companies.city}, ${normalized.city})`,
          region: sql`coalesce(${companies.region}, ${normalized.region})`,
          countryCode: sql`coalesce(${companies.countryCode}, ${normalized.countryCode})`,
          lat: sql`coalesce(${companies.lat}, ${normalized.lat})`,
          lon: sql`coalesce(${companies.lon}, ${normalized.lon})`,
        })
        .where(scope(companies, eq(companies.id, companyId)))

      // Provenance is additive: a second source confirming the same company is
      // exactly what the Art. 14 notice needs to list.
      await tx
        .insert(companySources)
        .values(
          values({
            companyId,
            sourceId: normalized.source,
            externalId: normalized.externalId,
            rawPayload: normalized.raw,
            fetchedAt: at,
          })
        )
        .onConflictDoNothing()
    },
    options.db
  )
}
