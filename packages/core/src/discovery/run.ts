import { type Database } from "@alg/db"
import { type DiscoveryAdapter, type RawEntity, type SearchSpec } from "@alg/shared"
import { dedupeBatch, toDedupeCandidate } from "./dedupe.js"
import { evaluateFilter } from "./filter-eval.js"
import { normalizeEntity, persistEntities, type PersistResult } from "./persist.js"
import { type DiscoveryRegistry } from "./registry.js"

/**
 * Executes a search: select adapters, fetch, post-filter, deduplicate, persist.
 *
 * Deduplication happens twice on purpose. First within the batch, in memory,
 * because Overpass and Places routinely return the same restaurant and comparing
 * them here costs nothing. Then against the database, which is the expensive part
 * and should see as few candidates as possible.
 */

export type ProgressEvent =
  | { type: "adapter_started"; adapterId: string }
  | { type: "adapter_finished"; adapterId: string; found: number; costEur: number }
  | { type: "adapter_failed"; adapterId: string; reason: string }
  | { type: "progress"; found: number; persisted: number }

export interface RunDiscoveryOptions {
  spec: SearchSpec
  workspaceId: string
  runId: string
  registry: DiscoveryRegistry
  db: Database
  /** Reported as the run progresses; backs the SSE stream. */
  onProgress?: (event: ProgressEvent) => void | Promise<void>
  signal?: AbortSignal
  /** Stops fetching once the spend would exceed this. */
  budgetEur?: number
}

export interface RunDiscoveryResult {
  found: number
  created: number
  duplicates: number
  costEur: number
  adapters: { adapterId: string; found: number; costEur: number; error?: string }[]
  outcomes: PersistResult["outcomes"]
}

export async function runDiscovery(options: RunDiscoveryOptions): Promise<RunDiscoveryResult> {
  const { spec, registry } = options
  const selections = registry.select(spec)

  const result: RunDiscoveryResult = {
    found: 0,
    created: 0,
    duplicates: 0,
    costEur: 0,
    adapters: [],
    outcomes: [],
  }

  if (selections.length === 0) {
    return result
  }

  const limit = spec.limit ?? 1000
  const collected: RawEntity[] = []

  for (const { adapter, postFiltered } of selections) {
    if (options.signal?.aborted) break
    if (collected.length >= limit) break

    const estimate = adapter.estimateCost(spec)
    if (
      options.budgetEur !== undefined &&
      result.costEur + estimate.estimatedCostEur > options.budgetEur
    ) {
      // Refusing to start is better than aborting mid-fetch: a partial page from
      // a paid API still costs the same as a whole one.
      result.adapters.push({
        adapterId: adapter.id,
        found: 0,
        costEur: 0,
        error: "budget_exceeded",
      })
      continue
    }

    await options.onProgress?.({ type: "adapter_started", adapterId: adapter.id })

    try {
      const entities = await fetchFromAdapter(adapter, spec, limit - collected.length, options)

      // Filters the adapter could not push down are applied here, against the
      // fields the adapter actually returned.
      const kept =
        postFiltered.length > 0
          ? entities.filter((entity) => evaluateFilter(spec.filters, toFilterValues(entity)))
          : entities

      collected.push(...kept)
      result.found += kept.length
      result.costEur += estimate.estimatedCostEur
      result.adapters.push({
        adapterId: adapter.id,
        found: kept.length,
        costEur: estimate.estimatedCostEur,
      })

      await options.onProgress?.({
        type: "adapter_finished",
        adapterId: adapter.id,
        found: kept.length,
        costEur: estimate.estimatedCostEur,
      })
    } catch (error) {
      // One failing source must not lose the results of the others.
      const reason = error instanceof Error ? error.message : String(error)
      result.adapters.push({ adapterId: adapter.id, found: 0, costEur: 0, error: reason })
      await options.onProgress?.({ type: "adapter_failed", adapterId: adapter.id, reason })
    }
  }

  // In-batch dedupe before touching the database.
  const { unique } = dedupeBatch(
    collected.map((entity, index) => {
      const normalized = normalizeEntity(entity)
      return {
        ...toDedupeCandidate({
          id: String(index),
          name: entity.name,
          nameNormalized: normalized?.nameNormalized ?? null,
          domain: normalized?.domain ?? null,
          phone: normalized?.phone ?? null,
          postalCode: normalized?.postalCode ?? null,
          sourceId: entity.source,
          externalId: entity.sourceId ?? null,
        }),
        entity,
      }
    })
  )

  const persisted = await persistEntities(
    unique.map((u) => u.entity),
    { workspaceId: options.workspaceId, runId: options.runId, db: options.db }
  )

  result.created = persisted.created
  result.duplicates = persisted.duplicates + (collected.length - unique.length)
  result.outcomes = persisted.outcomes

  await options.onProgress?.({
    type: "progress",
    found: result.found,
    persisted: result.created,
  })

  return result
}

/** Pages through an adapter until the limit is reached or it runs out. */
async function fetchFromAdapter(
  adapter: DiscoveryAdapter,
  spec: SearchSpec,
  remaining: number,
  options: RunDiscoveryOptions
): Promise<RawEntity[]> {
  const entities: RawEntity[] = []
  let cursor: string | undefined
  // Hard stop: a source that keeps returning a cursor must not loop forever.
  const MAX_PAGES = 10

  for (let page = 0; page < MAX_PAGES; page++) {
    if (options.signal?.aborted) break
    if (entities.length >= remaining) break

    const result = await adapter.search({ ...spec, limit: remaining - entities.length }, cursor)
    entities.push(...result.entities)

    if (!result.cursor) break
    cursor = result.cursor
  }

  return entities.slice(0, remaining)
}

/**
 * Flattens an entity into the key space post-filters address. Only core.* keys
 * exist at this stage - signal keys are filled in by the M2 provider layer.
 */
function toFilterValues(entity: RawEntity): Record<string, unknown> {
  const values: Record<string, unknown> = {
    "core.name": entity.name,
    "core.category": entity.categories ?? [],
  }

  if (entity.address) {
    if (entity.address.city !== null && entity.address.city !== undefined) {
      values["core.city"] = entity.address.city
    }
    if (entity.address.postal_code !== null && entity.address.postal_code !== undefined) {
      values["core.postal_code"] = entity.address.postal_code
    }
    if (entity.address.country !== null && entity.address.country !== undefined) {
      values["core.country"] = entity.address.country
    }
    if (entity.address.region !== null && entity.address.region !== undefined) {
      values["core.region"] = entity.address.region
    }
  }

  if (entity.geo) values["core.geo"] = entity.geo
  if (entity.website) values["core.website"] = entity.website
  if (entity.phone) values["core.phone"] = entity.phone
  if (entity.email) values["core.email"] = entity.email

  return values
}
