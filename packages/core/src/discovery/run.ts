import { type Database } from "@alg/db"
import {
  type DiscoveryAdapter,
  type FilterNode,
  type RawEntity,
  type SearchSpec,
  isBranchNode,
  isLeafNode,
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

  // `postFiltered` bleibt in der Auswahl - der Worker meldet es als Diagnose -,
  // steuert hier aber nichts mehr: gefiltert wird immer (siehe unten).
  for (const { adapter } of selections) {
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

      /**
       * Immer nachfiltern, nicht nur bei `postFiltered`.
       *
       * `postFiltered` stammt aus der statischen `supports`-Liste des Adapters -
       * einer Absichtserklaerung. Ob die Quelle den Filter *tatsaechlich*
       * angewendet hat, steht dort nicht. Google Places nennt `core.geo` als
       * unterstuetzt, laesst den Ortsbezug bei einem zu grossen Gebiet aber weg
       * (der Bias-Radius ist auf 50 km begrenzt) - und dann filtert niemand
       * mehr. So landeten bei einer Suche in Oesterreich Treffer aus
       * Neubrandenburg und Pafos in der Liste.
       *
       * Ein zweites Mal zu pruefen kostet nichts: die Werte liegen im
       * Arbeitsspeicher, und ein Treffer, der die Bedingung wirklich erfuellt,
       * ueberlebt beide Pruefungen. Ein Treffer, der sie nicht erfuellt, hatte
       * hier ohnehin nichts verloren.
       */
      const applicable = discoveryTimeFilters(spec.filters)
      const kept = applicable
        ? entities.filter((entity) => keepsEntity(applicable, entity))
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

  if (!isCoreKey(node.key)) return null

  /**
   * `core.category` ist quellenneutral - nachpruefbar ist es nicht.
   *
   * Der Filter traegt einen Slug ("craft_business"), die Quellen liefern ihr
   * eigenes Vokabular: Overpass rohe OSM-Werte ("carpenter", "works"), Places
   * Google-Typen ("restaurant", "store"). Ein Vergleich Slug gegen Tag trifft
   * nie - der Adapter lieferte fuenf passende Betriebe, der Nachfilter verwarf
   * alle fuenf, und der Lauf meldete `returned: 5, found: 0`.
   *
   * Die Bedingung ist damit nicht verloren, sondern bereits erfuellt: beide
   * Adapter uebersetzen den Slug und *suchen* danach. Ein zweites Mal zu
   * pruefen hiesse, dieselbe Frage in einer Sprache zu stellen, die die Antwort
   * nicht spricht.
   */
  if (node.key === "core.category") return null

  return node
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

/**
 * Wendet den Filter an, ohne einen Treffer an fehlenden Feldern scheitern zu lassen.
 *
 * Der Unterschied zu `evaluateFilter` allein: ein Feld, das die Quelle gar
 * nicht geliefert hat, gilt hier nicht als "passt nicht". Google Places fuehrt
 * `location` als optional - eine Linzer Firma ohne Koordinaten wuerde von einer
 * strengen bbox-Pruefung verworfen, obwohl sie genau das ist, wonach gesucht
 * wurde.
 *
 * Fuer `core.geo` gibt es einen zweiten Weg: liegt keine Koordinate vor, aber
 * ein Laendercode, entscheidet der. Das faengt den Fall ab, der die Liste
 * unbrauchbar machte (Pafos und Neubrandenburg in einer Oesterreich-Suche),
 * ohne einen brauchbaren Treffer wegen eines fehlenden Feldes zu opfern.
 */
function keepsEntity(filters: FilterNode, entity: RawEntity): boolean {
  const values = toFilterValues(entity)

  if (evaluateFilter(filters, values)) return true

  /**
   * Zweite Chance nur, wenn das Feld wirklich fehlt.
   *
   * Ein vorhandener, aber nicht passender Wert ist eine Absage - Wien ist nicht
   * Linz. Ein *fehlender* Wert ist keine: Places liefert weder `location` noch
   * `addressComponents` zuverlaessig, und einen Treffer daran scheitern zu
   * lassen heisst, unvollstaendige Daten wie eine Widerlegung zu behandeln.
   *
   * Deshalb wird die Bedingung ohne die ungemessenen Felder erneut geprueft:
   * bleibt sie erfuellt, lag es nur an fehlenden Daten.
   */
  const measurable = withoutUnknownFields(filters, values)
  if (measurable && !evaluateFilter(measurable, values)) return false

  // Der Filter scheitert also nur an fehlenden Feldern. Fuer Geo gibt es dann
  // noch den Laendercode als groben Ersatz; alles andere gilt als unbelegt.
  if (entity.geo) return true

  const bbox = firstGeoBbox(filters)
  if (!bbox) return true

  const country = entity.address?.country
  if (typeof country !== "string" || country.length === 0) {
    /**
     * Weder Koordinate noch Land: behalten.
     *
     * Ein Treffer ohne jede Ortsangabe ist nicht widerlegt, nur unbelegt - und
     * die Quelle hat ihn auf eine Anfrage mit Ortsbezug hin geliefert. Ihn hier
     * zu verwerfen hiesse, unvollstaendige Daten wie eine Absage zu behandeln;
     * genau diese Verwechslung hat schon einmal eine ganze Ergebnisliste
     * gekostet. Was falsch liegt und es *zeigt*, fliegt raus - der Rest bleibt.
     */
    return true
  }

  return countriesInBbox(bbox).has(country.toUpperCase())
}

/**
 * Der Filterbaum ohne die Bedingungen, die dieser Datensatz nicht beantworten kann.
 *
 * So laesst sich unterscheiden: scheitert der Filter an einem *falschen* Wert
 * (dann bleibt es dabei) oder nur an einem *fehlenden* (dann ist der Treffer
 * unbelegt, nicht widerlegt). Ohne diese Unterscheidung verwirft ein
 * Stadtfilter jeden Treffer, dessen Quelle die Stadt nicht mitgeliefert hat -
 * auch wenn er mitten in der gesuchten Stadt liegt.
 *
 * null heisst: nichts blieb uebrig, also gibt es nichts zu widerlegen.
 */
function withoutUnknownFields(
  node: FilterNode,
  values: Record<string, unknown>
): FilterNode | null {
  if (isBranchNode(node)) {
    const children = node.children
      .map((child) => withoutUnknownFields(child, values))
      .filter((child): child is FilterNode => child !== null)

    if (children.length === 0) return null
    if (children.length === 1) return children[0] ?? null
    return { ...node, children }
  }

  if (isNotNode(node)) {
    const child = withoutUnknownFields(node.child, values)
    return child === null ? null : { ...node, child }
  }

  if (!isLeafNode(node)) return null
  // `exists` fragt genau nach An- oder Abwesenheit - dort ist ein fehlendes
  // Feld die Antwort, nicht das Fehlen einer Antwort.
  if (node.op === "exists") return node

  return node.key in values ? node : null
}

/** Die erste bbox im Baum - Suchen haben in der Praxis genau eine. */
function firstGeoBbox(node: FilterNode): number[] | null {
  if (isBranchNode(node)) {
    for (const child of node.children) {
      const found = firstGeoBbox(child)
      if (found) return found
    }
    return null
  }
  if (isNotNode(node)) return null
  if (!isLeafNode(node) || node.key !== "core.geo") return null

  const value = node.value
  if (typeof value !== "object" || value === null) return null
  const bbox = Reflect.get(value, "bbox")
  return Array.isArray(bbox) && bbox.length === 4 ? bbox.map(Number) : null
}

/**
 * Welche Laender eine bbox beruehrt.
 *
 * Bewusst grob und bewusst kurz: die Liste deckt den deutschsprachigen Raum ab,
 * in dem gesucht wird. Ein unbekanntes Land heisst "nicht sicher drin" und
 * damit raus - lieber ein Treffer weniger als ein Restaurant auf Zypern in
 * einer Suche nach Baufirmen in Linz.
 */
const COUNTRY_BOXES: { code: string; bbox: [number, number, number, number] }[] = [
  { code: "AT", bbox: [46.37, 9.53, 49.02, 17.16] },
  { code: "DE", bbox: [47.27, 5.87, 55.06, 15.04] },
  { code: "CH", bbox: [45.82, 5.96, 47.81, 10.49] },
  { code: "LI", bbox: [47.05, 9.47, 47.27, 9.64] },
  { code: "IT", bbox: [36.65, 6.63, 47.09, 18.52] },
  { code: "SI", bbox: [45.42, 13.38, 46.88, 16.61] },
  { code: "SK", bbox: [47.73, 16.83, 49.61, 22.57] },
  { code: "CZ", bbox: [48.55, 12.09, 51.06, 18.86] },
  { code: "HU", bbox: [45.74, 16.11, 48.59, 22.9] },
]

function countriesInBbox(bbox: number[]): Set<string> {
  const [south = 0, west = 0, north = 0, east = 0] = bbox

  return new Set(
    COUNTRY_BOXES.filter((entry) => {
      const [cs, cw, cn, ce] = entry.bbox
      // Ueberschneidung, nicht Enthaltensein: eine Suche ueber Oberoesterreich
      // beruehrt auch Bayern, und eine Firma mit DE ist dort plausibel.
      return cs <= north && cn >= south && cw <= east && ce >= west
    }).map((entry) => entry.code)
  )
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
