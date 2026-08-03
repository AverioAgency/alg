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
  /** Test seam so contract tests never touch the network. */
  fetchImpl?: typeof safeFetch
}

export class OverpassAdapter implements DiscoveryAdapter {
  readonly id = "overpass"
  readonly targetTypes: TargetType[] = ["local_business"]
  readonly supports: string[] = [...OVERPASS_SUPPORTED_KEYS]

  private readonly options: Required<Omit<OverpassAdapterOptions, "fetchImpl">> & {
    fetchImpl: typeof safeFetch
  }

  constructor(options: OverpassAdapterOptions) {
    this.options = {
      endpoint: options.endpoint,
      userAgent: options.userAgent,
      timeoutMs: options.timeoutMs ?? 90_000,
      maxBytes: options.maxBytes ?? 32 * 1024 * 1024,
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

    const ql = renderOverpassQl(plan, Math.floor(this.options.timeoutMs / 1000))

    const response = await this.options.fetchImpl(this.options.endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(ql)}`,
      userAgent: this.options.userAgent,
      timeoutMs: this.options.timeoutMs,
      maxBytes: this.options.maxBytes,
    })

    if (response.status !== 200) {
      throw new Error(`Overpass responded with ${response.status}`)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(response.body)
    } catch {
      throw new Error("Overpass returned a body that is not JSON")
    }

    const result = OverpassResponseSchema.safeParse(parsed)
    if (!result.success) {
      throw new Error(`Overpass returned an unexpected shape: ${result.error.message}`)
    }

    const entities = result.data.elements
      .map((element) => toRawEntity(element))
      .filter((entity): entity is RawEntity => entity !== null)

    // Overpass has no cursor. `out N` caps the result set, so a full page means
    // the caller should narrow the area rather than page through it.
    return { entities, ...(cursor ? { cursor: undefined } : {}) }
  }
}

/**
 * Maps an OSM element onto RawEntity. Returns null for elements without a name -
 * an unnamed shop is not a lead, and OSM has many of them.
 */
export function toRawEntity(element: OverpassElement): RawEntity | null {
  const tags = element.tags ?? {}
  const name = tags["name"] ?? tags["operator"] ?? tags["brand"]
  if (!name) return null

  const point = element.center ?? { lat: element.lat, lon: element.lon }

  const street = tags["addr:street"]
  const houseNumber = tags["addr:housenumber"]

  const categories = ["amenity", "shop", "tourism", "office", "leisure", "craft"]
    .map((key) => (tags[key] ? `${key}=${tags[key]}` : null))
    .filter((value): value is string => value !== null)

  const entity: RawEntity = {
    source: "overpass",
    // Type prefix matters: node/1 and way/1 are different objects.
    sourceId: `${element.type}/${element.id}`,
    targetType: "local_business",
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
