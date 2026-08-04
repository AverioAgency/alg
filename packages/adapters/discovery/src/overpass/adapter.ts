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
  /**
   * Overpass meldet Laufzeitfehler mit HTTP 200 und leerer Elementliste.
   *
   * Der Text steht nur hier drin, etwa:
   *   "runtime error: Query timed out in \"query\" at line 1 after 36 seconds."
   *
   * Wer nur den Status prueft, liest das als "in Oesterreich gibt es keine
   * Restaurants" - eine erfolgreiche Antwort auf eine Abfrage, die nie lief.
   */
  remark: z.string().optional(),
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
  /**
   * Zeitlimit fuer die Mirrors, getrennt vom Hauptendpunkt.
   *
   * Gemessen haengen beide Mirrors ohne ein einziges Byte, bis jemand
   * abbricht. Ihnen dieselben 45s zu geben heisst, den Nutzer 90s auf zwei
   * Hosts warten zu lassen, die nichts liefern werden. Wer nach 15s nicht zu
   * senden begonnen hat, ist nicht langsam, sondern weg.
   */
  mirrorTimeoutMs?: number
  /** Attempts per endpoint before moving on. */
  maxAttempts?: number
  /** Injectable so retry tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>
  /** Test seam so contract tests never touch the network. */
  fetchImpl?: typeof safeFetch
}

/**
 * Public mirrors, in measured order of reliability.
 *
 * Gemessen am 2026-08-04 mit derselben Abfrage (Gastronomie, Oberoesterreich):
 *
 *   overpass-api.de        200 in 12-17s, reproduzierbar
 *   overpass.kumi.systems  keine Antwort, nach 70s abgebrochen
 *   overpass.private.coffee keine Antwort, nach 60s abgebrochen
 *
 * Beide Mirrors haengen also, statt zu antworten oder abzulehnen - genau das
 * Bild aus dem Fehlerlauf ("This operation was aborted" auf beiden). Sie
 * bleiben trotzdem drin: sie sind nichts wert, wenn der Hauptendpunkt laeuft,
 * aber alles wert, wenn er 504 liefert, und ihr Ausfall kostet nur Wartezeit
 * (siehe mirrorTimeoutMs).
 *
 * Nicht aufgenommen: overpass.osm.ch antwortet in 0.3s mit HTTP 200 und einer
 * leeren Elementliste - es ist eine Schweiz-Instanz. Als Fallback waere das der
 * schlimmste Fall von allen, weil "keine Firmen in Oberoesterreich" wie ein
 * gueltiges Ergebnis aussieht statt wie ein Fehler.
 */
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
    mirrorTimeoutMs: number
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
       * 75s auf dem Hauptendpunkt, 15s auf den Mirrors.
       *
       * Gemessen mit "Restaurants in Oesterreich" (20.2 Quadratgrad), dem Fall
       * der wiederholt leer zurueckkam:
       *
       *   nur node, [timeout:180]        200 nach 47s, 10 Treffer
       *   node+way+relation, [timeout:35] 200 nach 45s, 0 Treffer + remark
       *                                   "Query timed out after 36 seconds"
       *
       * Mit 45s brach also *unsere* Seite ab, bevor der Server fertig war - und
       * bei einem knapperen [timeout:] gab der Server auf und meldete das in
       * einem Feld, das niemand las. Ein ganzes Land ist eine legitime Frage;
       * sie dauert nur laenger als eine Stadt.
       *
       * Die Obergrenze bleibt endlich, weil ein Nutzer davor wartet. Die
       * Mirrors bekommen weiterhin nur 15s (siehe mirrorTimeoutMs), sonst
       * kostet ein ausgefallener Mirror mehr Zeit als der Hauptendpunkt.
       */
      timeoutMs: options.timeoutMs ?? 75_000,
      mirrorTimeoutMs: options.mirrorTimeoutMs ?? 15_000,
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
    /**
     * Eine Kategorie, die Overpass nicht kennt, ist kein Grund zur offenen Suche.
     *
     * `toCategoryTags` liefert fuer "it_services" oder "erp" nichts - solche
     * Betriebe tragen in OSM kein passendes Tag. Der Schluessel landet dann in
     * `unsupported` und die Query faellt auf ALL_BUSINESS_SELECTORS zurueck.
     * Damit fragt der Adapter *alle* Geschaefte eines Bundeslandes ab, um
     * anschliessend nachgelagert jedes Objekt zu verwerfen, weil keines
     * "it_services" ist: die teuerste denkbare Abfrage mit garantiert leerem
     * Ergebnis. Genau so entstanden die 504er bei null Treffern.
     *
     * Der Nutzer hat nach einer Branche gefragt. Sie hier stillschweigend
     * fallenzulassen, beantwortet eine andere Frage - also sagen wir, dass
     * Overpass die falsche Quelle ist, und ueberlassen die Suche den Adaptern,
     * die Freitext koennen (Google Places).
     */
    if (plan.categoryFilters.length === 0 && plan.unsupported.includes("core.category")) {
      throw new Error(
        "Overpass kennt diese Branche nicht - OpenStreetMap hat dafür kein Tag. " +
          "Diese Suche braucht eine Quelle mit Freitextsuche (Google Places) " +
          "oder eine Branche aus der Kategorienliste."
      )
    }

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

    /**
     * Overpass' eigenes Zeitlimit muss echt kleiner sein als unseres.
     *
     * Vorher waren beide 45s: wir brachen genau in dem Moment ab, in dem der
     * Server seine Antwort - und sei es eine ehrliche Fehlermeldung -
     * geschickt haette. Ein serverseitiger Abbruch nennt den Grund, unser
     * eigener sagt nur "aborted". Mit 10s Luft gewinnt immer der Server.
     *
     * Gerechnet wird gegen das Limit des Hauptendpunkts, nicht gegen das der
     * Mirrors: die Query wird einmal gebaut und an alle geschickt, und ein
     * kleineres [timeout:] wuerde dem Hauptendpunkt die Zeit nehmen, die er
     * fuer ein grosses Gebiet tatsaechlich braucht.
     */
    const serverTimeoutSeconds = Math.max(5, Math.floor(this.options.timeoutMs / 1000) - 10)
    const ql = renderOverpassQl(plan, serverTimeoutSeconds)
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

    /**
     * Ein Laufzeitfehler ist ein Fehler, auch mit HTTP 200.
     *
     * Nur wenn nichts zurueckkam: `remark` traegt gelegentlich auch Hinweise zu
     * einer geglueckten Abfrage, und Treffer wegzuwerfen, weil eine Anmerkung
     * dabeisteht, waere schlimmer als die Anmerkung zu ignorieren.
     */
    if (result.data.remark && result.data.elements.length === 0) {
      // Der haeufigste Fall ist ein Zeitlimit, und dagegen kann der Nutzer
      // etwas tun - also sagen wir, was, statt die Rohmeldung durchzureichen.
      const timedOut = /timed out/i.test(result.data.remark)
      throw new Error(
        timedOut
          ? `Overpass hat die Abfrage abgebrochen (${result.data.remark.trim()}). ` +
            "Das Gebiet ist für diese Branche zu groß — ein Bundesland oder ein " +
            "Ballungsraum statt des ganzen Landes kommt zurück."
          : `Overpass: ${result.data.remark.trim()}`
      )
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

    for (const [index, endpoint] of endpoints.entries()) {
      for (let attempt = 1; attempt <= this.options.maxAttempts; attempt++) {
        /**
         * Die volle Zeit bekommt nur der erste Versuch auf dem Hauptendpunkt.
         *
         * Ein grosses Gebiet braucht sie wirklich (Oesterreich: 47s gemessen),
         * aber sie multipliziert sich mit Versuchen und Endpunkten: 2 x 75s
         * plus zweimal 2 x 15s waeren 3.5 Minuten vor einem Ladebalken. Ein
         * 504 heisst "gerade ueberlastet" - der zweite Versuch bekommt darum
         * nur so lange, wie eine Antwort dauern wuerde, wenn es klappt, und
         * die Mirrors ohnehin (sie haengen gemessen, statt zu antworten).
         */
        const timeoutMs =
          index === 0 && attempt === 1 ? this.options.timeoutMs : this.options.mirrorTimeoutMs

        let status: number
        let responseBody: string

        try {
          const response = await this.options.fetchImpl(endpoint, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: `data=${encodeURIComponent(ql)}`,
            userAgent: this.options.userAgent,
            timeoutMs,
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
