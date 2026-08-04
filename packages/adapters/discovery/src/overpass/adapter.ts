import { z } from "zod"
import { safeFetch } from "@alg/core"
import {
  type CostEstimate,
  type DiscoveryAdapter,
  type DiscoveryResult,
  type RawEntity,
  type SearchSpec,
  type TargetType,
} from "@alg/shared"
import { OVERPASS_SUPPORTED_KEYS, planOverpassQuery, renderOverpassQl } from "./query.js"

/**
 * OpenStreetMap via the Overpass API.
 *
 * Free and without an API key, which makes it the default source for
 * local_business searches. The trade-off is coverage: OSM knows a restaurant's
 * position reliably, its phone number sometimes and its email rarely. Contact
 * enrichment is the signal layer's job in M2, not this adapter's.
 */

const OverpassElementSchema = z.object({
  type: z.enum(["node", "way", "relation"]),
  id: z.number(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  /** Ways and relations carry their representative point here (`out center`). */
  center: z.object({ lat: z.number(), lon: z.number() }).optional(),
  tags: z.record(z.string(), z.string()).optional(),
})

const OverpassResponseSchema = z.object({
  elements: z.array(OverpassElementSchema),
})

export type OverpassElement = z.infer<typeof OverpassElementSchema>

export interface OverpassAdapterOptions {
  endpoint: string
  userAgent: string
  /** Overpass is a shared free service; its own timeout must fit inside ours. */
  timeoutMs?: number
  maxBytes?: number
  /**
   * Tried in order when the primary endpoint is overloaded. The public instance
   * returns 429 or 504 regularly - often an HTML error page rather than JSON -
   * and a single-endpoint adapter turns that into an empty result set that looks
   * like "no restaurants in Linz".
   */
  fallbackEndpoints?: string[]
  /** Attempts per endpoint before moving on. */
  maxAttempts?: number
  /** Injectable so retry tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>
  /** Test seam so contract tests never touch the network. */
  fetchImpl?: typeof safeFetch
}

/** Public mirrors, in rough order of reliability. */
export const OVERPASS_FALLBACK_ENDPOINTS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
]

/** Statuses worth retrying: overload and gateway failures, not client errors. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

/**
 * Obergrenze fuer eine Suche ohne Branche, in Quadratgrad.
 *
 * Gemessen: der Raum Linz/Wels (0.25 x 0.45 = rund 0.11) liefert in 6s 500
 * Objekte; ganz Oberoesterreich (1.36 x 2.25 = rund 3.06) scheitert auf jedem
 * Endpunkt am Zeitlimit. 1.0 liegt dazwischen und laesst einen Ballungsraum
 * samt Umland zu, waehrend ein ganzes Bundesland eine Branche erfordert.
 *
 * Mit Branche gilt die Grenze nicht - craft=* ueber ganz Oberoesterreich kam in
 * 5s zurueck.
 */
const MAX_OPEN_SEARCH_SQUARE_DEGREES = 1.0

export class OverpassAdapter implements DiscoveryAdapter {
  readonly id = "overpass"
  /**
   * Both, but not equally well.
   *
   * local_business is what OSM maps thoroughly - a restaurant without a map
   * entry is rare. Companies are mapped unevenly: a joinery with a shopfront is
   * usually there, the same joinery in an industrial park often is not. A
   * company search over Overpass is therefore a seed list to enrich, not a
   * register, and the orchestrator should pair it with a paid source when
   * completeness matters.
   */
  readonly targetTypes: TargetType[] = ["local_business", "company"]
  readonly supports: string[] = [...OVERPASS_SUPPORTED_KEYS]

  private readonly options: {
    endpoint: string
    userAgent: string
    timeoutMs: number
    maxBytes: number
    fallbackEndpoints: string[]
    maxAttempts: number
    sleep: (ms: number) => Promise<void>
    fetchImpl: typeof safeFetch
  }

  constructor(options: OverpassAdapterOptions) {
    this.options = {
      endpoint: options.endpoint,
      userAgent: options.userAgent,
      /**
       * 45s, nicht 90s.
       *
       * Der Wert wird mit drei Endpunkten und zwei Versuchen multipliziert: bei
       * 90s wartet ein Lauf im schlechtesten Fall neun Minuten, bevor er
       * aufgibt - und der Nutzer sieht die ganze Zeit einen Ladebalken bei null
       * Treffern. Gemessen fuer Oberoesterreich: eine Kategorie-Abfrage kommt in
       * 5-15s zurueck, ein ueberlasteter Endpunkt scheitert nach 8-13s von
       * selbst. Was 45s nicht schafft, schafft auch 90s meist nicht - es kostet
       * nur die doppelte Wartezeit, bis der Mirror drankommt.
       */
      timeoutMs: options.timeoutMs ?? 45_000,
      maxBytes: options.maxBytes ?? 32 * 1024 * 1024,
      fallbackEndpoints: options.fallbackEndpoints ?? OVERPASS_FALLBACK_ENDPOINTS,
      maxAttempts: options.maxAttempts ?? 2,
      sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      fetchImpl: options.fetchImpl ?? safeFetch,
    }
  }

  estimateCost(spec: SearchSpec): CostEstimate {
    const limit = spec.limit ?? 1000
    const plan = planOverpassQuery(spec.filters, limit)

    const notes: string[] = []
    if (plan.unsupported.length > 0) {
      notes.push(`Nachgelagert ausgewertet: ${plan.unsupported.join(", ")}`)
    }
    if (!plan.area.bbox && !plan.area.around) {
      notes.push(
        "Ohne Geo-Filter fragt Overpass weltweit ab - das wird abgelehnt oder dauert sehr lange."
      )
    }

    return {
      // Overpass is free; the cost of a bad query is wall-clock time, not money.
      estimatedEntities: limit,
      estimatedCostEur: 0,
      estimatedSeconds: Math.min(120, Math.ceil(limit / 50) + 5),
      degraded: plan.unsupported.length > 0,
      notes,
    }
  }

  async search(spec: SearchSpec, cursor?: string): Promise<DiscoveryResult> {
    const limit = spec.limit ?? 1000
    const plan = planOverpassQuery(spec.filters, limit)

    if (!plan.area.bbox && !plan.area.around) {
      throw new Error(
        "Overpass requires a geographic constraint; add a core.geo filter with a bbox or a radius."
      )
    }

    /**
     * Eine offene Suche ueber eine grosse Flaeche lehnen wir ab, statt sie
     * abzuschicken.
     *
     * Gemessen fuer Oberoesterreich (rund 3.4 Quadratgrad): ohne Kategorie
     * scheitert die Abfrage nach 8-13s am Zeitlimit des Servers, und zwar auf
     * jedem Endpunkt. Der Adapter probiert danach zwei Mirrors durch, der Lauf
     * haengt minutenlang und endet bei null Treffern - ohne dass irgendwo
     * stuende, warum. Dieselbe Abfrage ueber den Raum Linz/Wels liefert in 6s
     * 500 Objekte.
     *
     * Frueh und mit einem umsetzbaren Hinweis zu scheitern ist deutlich besser
     * als eine lange Wartezeit auf eine leere Liste.
     */
    if (plan.categoryFilters.length === 0 && plan.area.bbox) {
      const [south = 0, west = 0, north = 0, east = 0] = plan.area.bbox
      const squareDegrees = Math.abs(north - south) * Math.abs(east - west)

      if (squareDegrees > MAX_OPEN_SEARCH_SQUARE_DEGREES) {
        throw new Error(
          `Dieses Gebiet ist für eine Suche ohne Branche zu groß (${squareDegrees.toFixed(1)} Quadratgrad, ` +
            `Grenze ${MAX_OPEN_SEARCH_SQUARE_DEGREES}). Wähle eine Branche oder ein kleineres Gebiet — ` +
            `Overpass bricht solche Abfragen serverseitig ab, statt sie zu beantworten.`
        )
      }
    }

    const ql = renderOverpassQl(plan, Math.floor(this.options.timeoutMs / 1000))
    const body = await this.fetchWithFallback(ql)

    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      // The public instance serves an HTML error page when overloaded, so a
      // parse failure here almost always means "busy", not "malformed data".
      throw new Error("Overpass returned a body that is not JSON (likely an error page)")
    }

    const result = OverpassResponseSchema.safeParse(parsed)
    if (!result.success) {
      throw new Error(`Overpass returned an unexpected shape: ${result.error.message}`)
    }

    const entities = result.data.elements
      // The target type comes from the spec rather than being hardcoded: the
      // same OSM object is a local_business in one search and a company in
      // another, and dedupe keys on it.
      .map((element) => toRawEntity(element, spec.targetType))
      .filter((entity): entity is RawEntity => entity !== null)

    // Overpass has no cursor. `out N` caps the result set, so a full page means
    // the caller should narrow the area rather than page through it.
    return { entities, ...(cursor ? { cursor: undefined } : {}) }
  }

  /**
   * Posts the query, retrying on overload and falling back to public mirrors.
   *
   * Every endpoint is tried maxAttempts times with a growing delay before moving
   * to the next. The last error is reported with the endpoints that were tried,
   * so a run that found nothing says why rather than looking like an empty area.
   */
  private async fetchWithFallback(ql: string): Promise<string> {
    const endpoints = [this.options.endpoint, ...this.options.fallbackEndpoints]
    const failures: string[] = []

    for (const endpoint of endpoints) {
      for (let attempt = 1; attempt <= this.options.maxAttempts; attempt++) {
        let status: number
        let responseBody: string

        try {
          const response = await this.options.fetchImpl(endpoint, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: `data=${encodeURIComponent(ql)}`,
            userAgent: this.options.userAgent,
            timeoutMs: this.options.timeoutMs,
            maxBytes: this.options.maxBytes,
          })
          status = response.status
          responseBody = response.body
        } catch (error) {
          // Network-level failure: worth another endpoint, not another attempt
          // against the same unreachable host.
          failures.push(`${endpoint}: ${error instanceof Error ? error.message : String(error)}`)
          break
        }

        if (status === 200) return responseBody

        failures.push(`${endpoint}: HTTP ${status}`)

        if (!RETRYABLE_STATUS.has(status)) break

        if (attempt < this.options.maxAttempts) {
          // Overpass publishes a rate limit of a couple of slots; backing off
          // briefly is more likely to succeed than hammering it.
          await this.options.sleep(1000 * attempt)
        }
      }
    }

    throw new Error(
      `Overpass unavailable after trying ${endpoints.length} endpoint(s): ${failures.join("; ")}`
    )
  }
}

/**
 * Maps an OSM element onto RawEntity. Returns null for elements without a name -
 * an unnamed shop is not a lead, and OSM has many of them.
 */
export function toRawEntity(
  element: OverpassElement,
  targetType: TargetType = "local_business"
): RawEntity | null {
  const tags = element.tags ?? {}
  const name = tags["name"] ?? tags["operator"] ?? tags["brand"]
  if (!name) return null

  const point = element.center ?? { lat: element.lat, lon: element.lon }

  const street = tags["addr:street"]
  const houseNumber = tags["addr:housenumber"]

  // Includes the company-side keys, so a firm found via man_made=works or
  // landuse=industrial carries its category into the record rather than
  // arriving with an empty one.
  const categories = [
    "amenity",
    "shop",
    "tourism",
    "office",
    "leisure",
    "craft",
    "man_made",
    "landuse",
    "building",
    "industrial",
  ]
    .map((key) => (tags[key] ? `${key}=${tags[key]}` : null))
    .filter((value): value is string => value !== null)

  const entity: RawEntity = {
    source: "overpass",
    // Type prefix matters: node/1 and way/1 are different objects.
    sourceId: `${element.type}/${element.id}`,
    targetType,
    name,
    raw: { ...tags, osm_type: element.type, osm_id: element.id },
  }

  if (street || houseNumber || tags["addr:postcode"] || tags["addr:city"]) {
    entity.address = {
      street: street ?? null,
      house_number: houseNumber ?? null,
      postal_code: tags["addr:postcode"] ?? null,
      city: tags["addr:city"] ?? null,
      region: tags["addr:state"] ?? null,
      country: tags["addr:country"] ?? null,
    }
  }

  if (typeof point.lat === "number" && typeof point.lon === "number") {
    entity.geo = { lat: point.lat, lon: point.lon }
  }

  const website = tags["website"] ?? tags["contact:website"] ?? tags["url"]
  if (website) entity.website = website

  const phone = tags["phone"] ?? tags["contact:phone"]
  if (phone) entity.phone = phone

  const email = tags["email"] ?? tags["contact:email"]
  if (email) entity.email = email

  if (categories.length > 0) entity.categories = categories

  return entity
}
