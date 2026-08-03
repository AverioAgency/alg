import { normalizeCompanyName } from "./normalize.js"

/**
 * The dedupe cascade.
 *
 * Four stages, strongest evidence first. The first stage that matches decides -
 * later stages never override an earlier verdict, and a non-match at one stage
 * does not veto the next.
 *
 *   1. source id  (place_id, OSM id)   - the source itself says they are the same
 *   2. domain                          - two companies rarely share a domain
 *   3. E.164 phone                     - strong, but shared switchboards exist
 *   4. trigram on name + postal code   - fuzzy, hence the postcode guard
 *
 * Stage 4 is the only probabilistic one. It requires the postal codes to match
 * exactly, because name similarity alone merges every "Gasthaus Zur Post" in the
 * country - of which Austria has a great many.
 */

export const DEFAULT_TRIGRAM_THRESHOLD = 0.85

export type DedupeStage = "source_id" | "domain" | "phone" | "fuzzy_name"

export interface DedupeCandidate {
  id: string
  sourceId?: string | null
  externalId?: string | null
  domain?: string | null
  phone?: string | null
  nameNormalized?: string | null
  postalCode?: string | null
}

export interface DedupeMatch {
  candidateId: string
  stage: DedupeStage
  /** 1 for the exact stages; the trigram score for fuzzy matches. */
  confidence: number
}

export interface DedupeOptions {
  /** Similarity required in stage 4. Matches the Postgres pg_trgm threshold. */
  trigramThreshold?: number
}

/**
 * Finds the first existing candidate that represents the same company as `incoming`.
 * Returns null when nothing matches, meaning the entity is genuinely new.
 */
export function findDuplicate(
  incoming: DedupeCandidate,
  candidates: readonly DedupeCandidate[],
  options: DedupeOptions = {}
): DedupeMatch | null {
  const threshold = options.trigramThreshold ?? DEFAULT_TRIGRAM_THRESHOLD

  // Stage 1: same source, same external id.
  if (incoming.sourceId && incoming.externalId) {
    for (const candidate of candidates) {
      if (
        candidate.sourceId === incoming.sourceId &&
        candidate.externalId === incoming.externalId
      ) {
        return { candidateId: candidate.id, stage: "source_id", confidence: 1 }
      }
    }
  }

  // Stage 2: same registrable domain.
  if (incoming.domain) {
    for (const candidate of candidates) {
      if (candidate.domain && candidate.domain === incoming.domain) {
        return { candidateId: candidate.id, stage: "domain", confidence: 1 }
      }
    }
  }

  // Stage 3: same E.164 number.
  if (incoming.phone) {
    for (const candidate of candidates) {
      if (candidate.phone && candidate.phone === incoming.phone) {
        return { candidateId: candidate.id, stage: "phone", confidence: 1 }
      }
    }
  }

  // Stage 4: similar name in the same postcode.
  if (incoming.nameNormalized && incoming.postalCode) {
    let best: DedupeMatch | null = null

    for (const candidate of candidates) {
      if (!candidate.nameNormalized || !candidate.postalCode) continue
      if (candidate.postalCode !== incoming.postalCode) continue

      const score = trigramSimilarity(incoming.nameNormalized, candidate.nameNormalized)
      if (score >= threshold && (!best || score > best.confidence)) {
        best = { candidateId: candidate.id, stage: "fuzzy_name", confidence: score }
      }
    }

    if (best) return best
  }

  return null
}

/**
 * Trigram similarity compatible with Postgres pg_trgm's similarity().
 *
 * pg_trgm pads each word with two leading spaces and one trailing space, then
 * counts shared trigrams over the union. Mirroring that here keeps in-memory
 * dedupe consistent with the SQL-side index lookup - otherwise the same pair
 * would merge in one path and not the other.
 */
export function trigramSimilarity(a: string, b: string): number {
  if (a === b) return 1

  const left = trigrams(a)
  const right = trigrams(b)

  if (left.size === 0 && right.size === 0) return 1
  if (left.size === 0 || right.size === 0) return 0

  let shared = 0
  for (const trigram of left) {
    if (right.has(trigram)) shared++
  }

  const union = left.size + right.size - shared
  return union === 0 ? 0 : Number((shared / union).toFixed(6))
}

export function trigrams(input: string): Set<string> {
  const result = new Set<string>()
  const words = input
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0)

  for (const word of words) {
    const padded = `  ${word} `
    for (let i = 0; i < padded.length - 2; i++) {
      result.add(padded.slice(i, i + 3))
    }
  }

  return result
}

/**
 * Deduplicates a freshly fetched batch against itself, before it ever reaches the
 * database. Adapters overlap heavily - Overpass and Places both know the same
 * restaurant - so this removes the bulk of duplicates in memory.
 */
export function dedupeBatch<T extends DedupeCandidate>(
  entities: readonly T[],
  options: DedupeOptions = {}
): { unique: T[]; duplicates: { entity: T; match: DedupeMatch }[] } {
  const unique: T[] = []
  const duplicates: { entity: T; match: DedupeMatch }[] = []

  for (const entity of entities) {
    const match = findDuplicate(entity, unique, options)
    if (match) {
      duplicates.push({ entity, match })
    } else {
      unique.push(entity)
    }
  }

  return { unique, duplicates }
}

/** Builds a dedupe candidate from raw company fields. */
export function toDedupeCandidate(input: {
  id: string
  name?: string | null
  nameNormalized?: string | null
  domain?: string | null
  phone?: string | null
  postalCode?: string | null
  sourceId?: string | null
  externalId?: string | null
}): DedupeCandidate {
  return {
    id: input.id,
    sourceId: input.sourceId ?? null,
    externalId: input.externalId ?? null,
    domain: input.domain ?? null,
    phone: input.phone ?? null,
    nameNormalized: input.nameNormalized ?? normalizeCompanyName(input.name),
    postalCode: input.postalCode ?? null,
  }
}
