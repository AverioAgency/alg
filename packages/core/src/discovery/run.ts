import { type Database } from "@alg/db"
import {
  type DiscoveryAdapter,
  type FilterNode,
  type RawEntity,
  type SearchSpec,
  isBranchNode,
  isNotNode,
} from "@alg/shared"
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
  | {
      type: "adapter_finished"
      adapterId: string
      /** Was die Quelle lieferte, vor den Nachfiltern. */
      returned: number
      found: number
      costEur: number
    }
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
  /**
   * Pro Adapter, und zwar mit beiden Zahlen.
   *
   * `returned` ist, was die Quelle geliefert hat, `found` was nach den
   * Nachfiltern uebrig blieb. Ohne die Unterscheidung sieht "Overpass kennt
   * dieses Gebiet nicht" genauso aus wie "500 Treffer, alle vom Filter
   * verworfen" - beides stand als found: 0 im Lauf, und die Diagnose begann
   * jedesmal bei null. Die Differenz benennt den Schuldigen sofort.
   */
  adapters: {
    adapterId: string
    returned: number
    found: number
    costEur: number
    error?: string
  }[]
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
        returned: 0,
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
      // fields the adapter actually returned - but only those that can be
      // answered yet (see discoveryTimeFilters).
      const applicable = discoveryTimeFilters(spec.filters)
      const kept =
        postFiltered.length > 0 && applicable
          ? entities.filter((entity) => evaluateFilter(applicable, toFilterValues(entity)))
          : entities

      collected.push(...kept)
      result.found += kept.length
      result.costEur += estimate.estimatedCostEur
      result.adapters.push({
        adapterId: adapter.id,
        returned: entities.length,
        found: kept.length,
        costEur: estimate.estimatedCostEur,
      })

      await options.onProgress?.({
        type: "adapter_finished",
        adapterId: adapter.id,
        returned: entities.length,
        found: kept.length,
        costEur: estimate.estimatedCostEur,
      })
    } catch (error) {
      // One failing source must not lose the results of the others.
      const reason = error instanceof Error ? error.message : String(error)
      result.adapters.push({
        adapterId: adapter.id,
        returned: 0,
        found: 0,
        costEur: 0,
        error: reason,
      })
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
/**
 * Entfernt alles aus dem Filterbaum, was zur Discovery-Zeit noch nicht existiert.
 *
 * Ein Signalfilter (`web.presence.has_website`, `legal.impressum.*`) beschreibt
 * eine Eigenschaft, die erst die Anreicherung ermittelt - der Adapter liefert
 * Kernfelder und sonst nichts. Der Nachfilter bewertet einen fehlenden Wert
 * jedoch als "passt nicht", und zwar zu Recht: sonst wuerde ein nie gemessenes
 * Signal als erfuellt durchgehen.
 *
 * Beides zusammen hiess: die Suche "Betriebe ohne Website" verwarf jeden
 * einzelnen Treffer, den sie gerade bezahlt hatte, und meldete null - ohne
 * Fehler, nicht zu unterscheiden von einer leeren Gegend. Der Filter war nicht
 * falsch, er war nur zu frueh dran.
 *
 * Signalbedingungen greifen weiterhin, nur spaeter: die Anreicherung fuellt sie,
 * die Rubrik bewertet sie. Hier bleiben sie aussen vor.
 *
 * Ein Knoten, von dem nichts uebrig bleibt, wird zu `null` - der Aufrufer
 * filtert dann gar nicht, statt gegen einen leeren AND-Knoten zu pruefen.
 */
export function discoveryTimeFilters(node: FilterNode | undefined): FilterNode | null {
  if (!node) return null

  if (isBranchNode(node)) {
    const children = node.children
      .map((child) => discoveryTimeFilters(child))
      .filter((child): child is FilterNode => child !== null)

    if (children.length === 0) return null
    if (children.length === 1) return children[0] ?? null
    return { ...node, children }
  }

  if (isNotNode(node)) {
    const child = discoveryTimeFilters(node.child)
    // Die Negation einer Bedingung, die wir nicht pruefen koennen, ist selbst
    // nicht pruefbar - und nicht etwa "trifft zu".
    return child === null ? null : { ...node, child }
  }

  return isCoreKey(node.key) ? node : null
}

/**
 * Kernfelder liefert jeder Adapter direkt; alles andere entsteht spaeter.
 *
 * Bewusst nach Praefix statt gegen eine Liste bekannter Signale: ein neuer
 * Provider bringt neue Schluessel mit, und die duerfen nicht dadurch in die
 * Discovery geraten, dass jemand vergisst, sie hier einzutragen.
 */
function isCoreKey(key: string): boolean {
  return key.startsWith("core.")
}

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
