import { z } from "zod"
import { safeFetch } from "@alg/core"
import {
  type CostEstimate,
  type DiscoveryAdapter,
  type DiscoveryResult,
  type FilterNode,
  type RawEntity,
  type SearchSpec,
  type TargetType,
  isBranchNode,
  isLeafNode,
  isNotNode,
} from "@alg/shared"
import { CURRENT_PLACES_PRICING, estimatePlacesCost, type PricingTable } from "./pricing.js"

/**
 * Google Places API (New), Text Search endpoint.
 *
 * Complements Overpass rather than replacing it: Places has far better contact
 * coverage and opening hours, but every request costs money and the terms forbid
 * storing most fields long-term. We keep only what a lead record needs - name,
 * address, phone, website - and the place id for deduplication.
 *
 * Field masks are mandatory in the new API and directly determine the price, so
 * they are declared explicitly here rather than requesting everything.
 */

const PlaceSchema = z.object({
  id: z.string(),
  displayName: z.object({ text: z.string() }).optional(),
  formattedAddress: z.string().optional(),
  addressComponents: z
    .array(
      z.object({
        longText: z.string(),
        shortText: z.string().optional(),
        types: z.array(z.string()),
      })
    )
    .optional(),
  location: z.object({ latitude: z.number(), longitude: z.number() }).optional(),
  nationalPhoneNumber: z.string().optional(),
  internationalPhoneNumber: z.string().optional(),
  websiteUri: z.string().optional(),
  primaryType: z.string().optional(),
  types: z.array(z.string()).optional(),
  rating: z.number().optional(),
  userRatingCount: z.number().optional(),
  businessStatus: z.string().optional(),
})

const TextSearchResponseSchema = z.object({
  places: z.array(PlaceSchema).optional(),
  nextPageToken: z.string().optional(),
})

export type Place = z.infer<typeof PlaceSchema>

/** Filter keys Places can serve inside the query itself. */
export const PLACES_SUPPORTED_KEYS = [
  "core.geo",
  "core.category",
  "core.name",
  "core.city",
] as const

/**
 * Only the fields a lead record actually needs. Every additional field raises the
 * billing tier, and Google's terms restrict retention of the rest anyway.
 */
const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.addressComponents",
  "places.location",
  "places.nationalPhoneNumber",
  "places.internationalPhoneNumber",
  "places.websiteUri",
  "places.primaryType",
  "places.types",
  "places.businessStatus",
  "nextPageToken",
].join(",")

export interface PlacesAdapterOptions {
  apiKey: string
  userAgent: string
  endpoint?: string
  /** Language for names and addresses. */
  languageCode?: string
  regionCode?: string
  pricing?: PricingTable
  timeoutMs?: number
  fetchImpl?: typeof safeFetch
}

export class PlacesAdapter implements DiscoveryAdapter {
  readonly id = "google_places"
  readonly targetTypes: TargetType[] = ["local_business"]
  readonly supports: string[] = [...PLACES_SUPPORTED_KEYS]

  private readonly endpoint: string
  private readonly apiKey: string
  private readonly userAgent: string
  private readonly languageCode: string
  private readonly regionCode: string
  private readonly pricing: PricingTable
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof safeFetch

  constructor(options: PlacesAdapterOptions) {
    this.apiKey = options.apiKey
    this.userAgent = options.userAgent
    this.endpoint = options.endpoint ?? "https://places.googleapis.com/v1/places:searchText"
    this.languageCode = options.languageCode ?? "de"
    this.regionCode = options.regionCode ?? "AT"
    this.pricing = options.pricing ?? CURRENT_PLACES_PRICING
    this.timeoutMs = options.timeoutMs ?? 20_000
    this.fetchImpl = options.fetchImpl ?? safeFetch
  }

  estimateCost(spec: SearchSpec): CostEstimate {
    const limit = spec.limit ?? 60
    const plan = planPlacesQuery(spec)
    const estimate = estimatePlacesCost({ limit, withDetails: false, pricing: this.pricing })

    const notes: string[] = []
    if (plan.unsupported.length > 0) {
      notes.push(`Nachgelagert ausgewertet: ${plan.unsupported.join(", ")}`)
    }

    const reachable = Math.min(limit, this.pricing.maxPages * this.pricing.pageSize)
    if (limit > reachable) {
      // Worth stating plainly: a user asking for 500 results would otherwise
      // silently receive 60 and assume that is all that exists.
      notes.push(
        `Places liefert maximal ${reachable} Treffer pro Suche (${this.pricing.maxPages} Seiten à ${this.pricing.pageSize}). Für mehr die Suche geografisch aufteilen.`
      )
    }

    return {
      estimatedEntities: reachable,
      estimatedCostEur: estimate.costEur,
      estimatedSeconds: estimate.pages * 3,
      degraded: plan.unsupported.length > 0,
      notes,
    }
  }

  async search(spec: SearchSpec, cursor?: string): Promise<DiscoveryResult> {
    const limit = spec.limit ?? 60
    const plan = planPlacesQuery(spec)

    if (!plan.textQuery && !plan.locationBias) {
      throw new Error(
        "Google Places requires a text query or a location; add a core.category, core.name or core.geo filter."
      )
    }

    const body: Record<string, unknown> = {
      textQuery: plan.textQuery || "business",
      languageCode: this.languageCode,
      regionCode: this.regionCode,
      maxResultCount: Math.min(limit, this.pricing.pageSize),
    }
    /**
     * Ein Kreis gehoert zu locationBias, nicht zu locationRestriction.
     *
     * Die Text-Search-API ist da streng: locationRestriction akzeptiert
     * ausschliesslich ein Rechteck ("rectangular Viewport"), waehrend
     * locationBias beides nimmt. Wir bauen aus der bbox einen Kreis (toLocationBias)
     * und haben ihn als locationRestriction geschickt - Google antwortete
     * folgerichtig mit HTTP 400, und zwar bei jeder Suche mit Geo-Filter.
     *
     * Der Unterschied ist nicht nur formal: restriction schliesst alles
     * ausserhalb aus, bias gewichtet nur. Fuer eine Lead-Suche ist bias das
     * richtige Verhalten - ein Betrieb knapp ausserhalb der gerundeten bbox ist
     * immer noch ein Treffer.
     */
    if (plan.locationBias) body.locationBias = plan.locationBias
    if (cursor) body.pageToken = cursor

    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": this.apiKey,
        "x-goog-fieldmask": FIELD_MASK,
      },
      body: JSON.stringify(body),
      userAgent: this.userAgent,
      timeoutMs: this.timeoutMs,
    })

    if (response.status !== 200) {
      /**
       * Googles Begruendung mitgeben, aber nur die Begruendung.
       *
       * Der rohe Body darf nicht ins Log: Google spiegelt bei manchen Fehlern
       * die Anfrage zurueck, und darin steckt der API-Schluessel. Die Felder
       * `error.message` und `error.status` enthalten ihn nie - und ohne sie
       * stand hier nur "responded with 400", was einen Konfigurationsfehler von
       * einem falsch gebauten Request ununterscheidbar macht.
       */
      throw new Error(
        `Google Places responded with ${response.status}${describePlacesError(response.body)}`
      )
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(response.body)
    } catch {
      throw new Error("Google Places returned a body that is not JSON")
    }

    const result = TextSearchResponseSchema.safeParse(parsed)
    if (!result.success) {
      throw new Error(`Google Places returned an unexpected shape: ${result.error.message}`)
    }

    const entities = (result.data.places ?? [])
      .map((place) => toRawEntity(place))
      .filter((entity): entity is RawEntity => entity !== null)

    return result.data.nextPageToken
      ? { entities, cursor: result.data.nextPageToken }
      : { entities }
  }
}

export interface PlacesQueryPlan {
  /** Free-text part, assembled from category, name and city. */
  textQuery: string
  locationBias?: { circle: { center: { latitude: number; longitude: number }; radius: number } }
  unsupported: string[]
}

/**
 * Places has no structured filter language - it takes a text query plus an
 * optional location. So the plan assembles words rather than predicates, and
 * anything that cannot be expressed that way is post-filtered.
 */
export function planPlacesQuery(spec: SearchSpec): PlacesQueryPlan {
  const plan: PlacesQueryPlan = { textQuery: "", unsupported: [] }
  const words: string[] = []

  const visit = (node: FilterNode, negated: boolean): void => {
    if (isNotNode(node)) {
      visit(node.child, true)
      return
    }
    if (isBranchNode(node)) {
      if (node.op === "and" && !negated) {
        node.children.forEach((child) => visit(child, false))
      } else {
        node.children.forEach((child) => {
          for (const key of keysOf(child)) plan.unsupported.push(key)
        })
      }
      return
    }
    if (!isLeafNode(node)) return

    if (negated) {
      plan.unsupported.push(node.key)
      return
    }

    switch (node.key) {
      case "core.category":
      case "core.name":
      case "core.city": {
        const values = Array.isArray(node.value) ? node.value : [node.value]
        const usable = values.filter((v): v is string => typeof v === "string" && v.length > 0)
        if (usable.length > 0) {
          words.push(...usable)
        } else {
          plan.unsupported.push(node.key)
        }
        break
      }
      case "core.geo": {
        const bias = toLocationBias(node.value)
        if (bias) {
          plan.locationBias = bias
        } else {
          plan.unsupported.push(node.key)
        }
        break
      }
      default:
        plan.unsupported.push(node.key)
    }
  }

  visit(spec.filters, false)
  plan.textQuery = words.join(" ").trim()
  return plan
}

function keysOf(node: FilterNode): string[] {
  if (isBranchNode(node)) return node.children.flatMap(keysOf)
  if (isNotNode(node)) return keysOf(node.child)
  return isLeafNode(node) ? [node.key] : []
}

/**
 * Liest Googles Fehlergrund aus dem Antwort-Body - aber nur `error.status`.
 *
 * `error.message` waere aussagekraeftiger und ist trotzdem tabu: Google
 * schreibt den API-Schluessel hinein ("API key not valid: AIza..."), was ein
 * bestehender Test hier festhaelt. `status` ist dagegen ein festes Enum
 * (INVALID_ARGUMENT, PERMISSION_DENIED, RESOURCE_EXHAUSTED, ...) und kann
 * konstruktionsbedingt kein Geheimnis tragen.
 *
 * Das genuegt fuer die Diagnose: INVALID_ARGUMENT heisst "wir bauen den Request
 * falsch", PERMISSION_DENIED "der Schluessel stimmt nicht oder die API ist nicht
 * freigeschaltet". Vorher stand nur "responded with 400" - und die beiden Faelle
 * waren nicht unterscheidbar.
 */
function describePlacesError(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== "object" || parsed === null) return ""
    const error = Reflect.get(parsed, "error")
    if (typeof error !== "object" || error === null) return ""

    const status = Reflect.get(error, "status")
    // Nur der Enum-Wert, und auch der nur, wenn er wie einer aussieht.
    return typeof status === "string" && /^[A-Z_]{3,40}$/.test(status) ? ` (${status})` : ""
  } catch {
    return ""
  }
}

function toLocationBias(value: unknown): PlacesQueryPlan["locationBias"] {
  if (typeof value !== "object" || value === null) return undefined
  const spec = value as { lat?: unknown; lon?: unknown; radiusMetres?: unknown; bbox?: unknown }

  if (Array.isArray(spec.bbox) && spec.bbox.length === 4) {
    // Places wants a circle; approximate the bbox by its centre and half-diagonal.
    const [south, west, north, east] = spec.bbox.map(Number)
    if ([south, west, north, east].some((n) => !Number.isFinite(n))) return undefined
    const lat = ((south as number) + (north as number)) / 2
    const lon = ((west as number) + (east as number)) / 2
    const latSpanM = Math.abs((north as number) - (south as number)) * 111_320
    const lonSpanM =
      Math.abs((east as number) - (west as number)) * 111_320 * Math.cos((lat * Math.PI) / 180)
    const radius = Math.min(50_000, Math.sqrt(latSpanM ** 2 + lonSpanM ** 2) / 2)
    return { circle: { center: { latitude: lat, longitude: lon }, radius } }
  }

  const lat = Number(spec.lat)
  const lon = Number(spec.lon)
  const radius = Number(spec.radiusMetres)
  if ([lat, lon, radius].every((n) => Number.isFinite(n)) && radius > 0) {
    // Places caps the radius at 50 km.
    return {
      circle: { center: { latitude: lat, longitude: lon }, radius: Math.min(50_000, radius) },
    }
  }

  return undefined
}

/** Maps a Place onto RawEntity. Returns null when there is no usable name. */
export function toRawEntity(place: Place): RawEntity | null {
  const name = place.displayName?.text
  if (!name) return null

  // Permanently closed businesses are not leads.
  if (place.businessStatus === "CLOSED_PERMANENTLY") return null

  const entity: RawEntity = {
    source: "google_places",
    sourceId: place.id,
    targetType: "local_business",
    name,
    raw: { ...place },
  }

  const components = place.addressComponents ?? []
  const component = (type: string): string | null =>
    components.find((c) => c.types.includes(type))?.longText ?? null

  const street = component("route")
  const houseNumber = component("street_number")
  const postalCode = component("postal_code")
  const city = component("locality") ?? component("postal_town")
  const region = component("administrative_area_level_1")
  const country = components.find((c) => c.types.includes("country"))?.shortText ?? null

  if (street || postalCode || city) {
    entity.address = {
      street,
      house_number: houseNumber,
      postal_code: postalCode,
      city,
      region,
      country,
    }
  }

  if (place.location) {
    entity.geo = { lat: place.location.latitude, lon: place.location.longitude }
  }

  if (place.websiteUri) entity.website = place.websiteUri
  // Prefer the international format: it normalizes to E.164 without guessing.
  const phone = place.internationalPhoneNumber ?? place.nationalPhoneNumber
  if (phone) entity.phone = phone

  const categories = place.types ?? (place.primaryType ? [place.primaryType] : [])
  if (categories.length > 0) entity.categories = categories

  return entity
}
