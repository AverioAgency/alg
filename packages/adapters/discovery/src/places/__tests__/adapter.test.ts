import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"
import { type SearchSpec } from "@alg/shared"
import { PlacesAdapter, planPlacesQuery, toRawEntity } from "../adapter.js"
import { estimatePlacesCost, CURRENT_PLACES_PRICING } from "../pricing.js"

/**
 * Contract test against a recorded Places response. Never a live call: this API
 * bills per request, so a test suite that hit it would cost money on every run.
 */

const FIXTURES = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures")

function fakeFetch(body: string, status = 200) {
  return vi.fn(async () => ({
    status,
    headers: new Headers(),
    body,
    url: "https://places.googleapis.com/v1/places:searchText",
  }))
}

const linzSpec: SearchSpec = {
  targetType: "local_business",
  filters: {
    op: "and",
    children: [
      { op: "eq", key: "core.category", value: "Restaurant" },
      { op: "eq", key: "core.city", value: "Linz" },
      { op: "within", key: "core.geo", value: { lat: 48.3, lon: 14.28, radiusMetres: 5000 } },
    ],
  },
  limit: 20,
}

function makeAdapter(fetchImpl: ReturnType<typeof fakeFetch>) {
  return new PlacesAdapter({
    apiKey: "test-key",
    userAgent: "AlgBot/1.0",
    fetchImpl: fetchImpl as never,
  })
}

describe("PlacesAdapter", () => {
  it("serves local_business", () => {
    const adapter = makeAdapter(fakeFetch("{}"))
    expect(adapter.id).toBe("google_places")
    expect(adapter.targetTypes).toStrictEqual(["local_business"])
  })

  it("normalizes a recorded response", async () => {
    const fetchImpl = fakeFetch(await readFile(join(FIXTURES, "linz-restaurants.json"), "utf8"))
    const { entities } = await makeAdapter(fetchImpl).search(linzSpec)

    // Four places in, two out: one is permanently closed, one has no name.
    expect(entities).toHaveLength(2)
    expect(entities.map((e) => e.name)).toStrictEqual(["Gasthaus Zur Post", "Bistro Beispiel"])
  })

  it("maps address components into structured fields", async () => {
    const fetchImpl = fakeFetch(await readFile(join(FIXTURES, "linz-restaurants.json"), "utf8"))
    const { entities } = await makeAdapter(fetchImpl).search(linzSpec)

    const post = entities[0]
    expect(post?.sourceId).toBe("ChIJVXealLU_xkcRja_At0z9AGY")
    expect(post?.address).toMatchObject({
      street: "Hauptplatz",
      house_number: "8",
      postal_code: "4020",
      city: "Linz",
      country: "AT",
    })
    expect(post?.geo).toStrictEqual({ lat: 48.3060537, lon: 14.2865461 })
  })

  it("prefers the international phone format", async () => {
    // The national format needs a country guess to normalize; the international
    // one does not, and a wrong guess merges two companies in the dedupe cascade.
    const fetchImpl = fakeFetch(await readFile(join(FIXTURES, "linz-restaurants.json"), "utf8"))
    const { entities } = await makeAdapter(fetchImpl).search(linzSpec)

    expect(entities[0]?.phone).toBe("+43 732 771234")
  })

  it("drops permanently closed businesses", async () => {
    const fetchImpl = fakeFetch(await readFile(join(FIXTURES, "linz-restaurants.json"), "utf8"))
    const { entities } = await makeAdapter(fetchImpl).search(linzSpec)

    expect(entities.some((e) => e.name === "Ehemaliges Lokal")).toBe(false)
  })

  it("returns the page token as a cursor", async () => {
    const fetchImpl = fakeFetch(await readFile(join(FIXTURES, "linz-restaurants.json"), "utf8"))
    const result = await makeAdapter(fetchImpl).search(linzSpec)

    expect(result.cursor).toBe("AeJbb3cBBBBBBBBBBBBBBBBBBBBBBBBB")
  })

  it("sends the api key as a header, never in the URL", async () => {
    // A key in the query string ends up in proxy logs and browser history.
    const fetchImpl = fakeFetch(await readFile(join(FIXTURES, "linz-restaurants.json"), "utf8"))
    await makeAdapter(fetchImpl).search(linzSpec)

    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(String(url)).not.toContain("test-key")
    expect((init as { headers: Record<string, string> })?.headers["x-goog-api-key"]).toBe(
      "test-key"
    )
  })

  it("requests only the fields a lead record needs", async () => {
    // The field mask determines the billing tier - requesting everything is expensive.
    const fetchImpl = fakeFetch(await readFile(join(FIXTURES, "linz-restaurants.json"), "utf8"))
    await makeAdapter(fetchImpl).search(linzSpec)

    const init = fetchImpl.mock.calls[0]?.[1] as { headers: Record<string, string> }
    const mask = init.headers["x-goog-fieldmask"] ?? ""
    expect(mask).toContain("places.id")
    expect(mask).toContain("places.displayName")
    expect(mask).not.toContain("places.reviews")
    expect(mask).not.toContain("places.photos")
  })

  it("builds a text query from category, name and city", async () => {
    const fetchImpl = fakeFetch(await readFile(join(FIXTURES, "linz-restaurants.json"), "utf8"))
    await makeAdapter(fetchImpl).search(linzSpec)

    const init = fetchImpl.mock.calls[0]?.[1] as { body: string }
    const body: unknown = JSON.parse(init.body)
    expect((body as { textQuery: string }).textQuery).toBe("Restaurant Linz")
    // locationBias, nicht locationRestriction: die Text-Search-API akzeptiert
    // bei restriction nur ein Rechteck, wir schicken einen Kreis. Als
    // restriction ergab das HTTP 400 bei jeder Suche mit Geo-Filter.
    expect((body as { locationBias?: unknown }).locationBias).toBeDefined()
  })

  it("passes a cursor through as a page token", async () => {
    const fetchImpl = fakeFetch(await readFile(join(FIXTURES, "linz-restaurants.json"), "utf8"))
    await makeAdapter(fetchImpl).search(linzSpec, "TOKEN123")

    const init = fetchImpl.mock.calls[0]?.[1] as { body: string }
    expect(JSON.parse(init.body)).toMatchObject({ pageToken: "TOKEN123" })
  })

  it("refuses a spec with nothing to search for", async () => {
    const adapter = makeAdapter(fakeFetch("{}"))
    await expect(
      adapter.search({
        targetType: "local_business",
        filters: { op: "eq", key: "web.presence.has_website", value: false },
      })
    ).rejects.toThrow(/text query or a location/)
  })

  it("does not leak the response body on an error status", async () => {
    // Google echoes the key in some error envelopes.
    const adapter = makeAdapter(fakeFetch('{"error":{"message":"key test-key invalid"}}', 403))
    await expect(adapter.search(linzSpec)).rejects.toThrow(/403/)
    await expect(adapter.search(linzSpec)).rejects.not.toThrow(/test-key/)
  })

  it("rejects an unexpected response shape", async () => {
    const adapter = makeAdapter(fakeFetch(JSON.stringify({ notAPlacesResponse: true, places: 7 })))
    await expect(adapter.search(linzSpec)).rejects.toThrow(/unexpected shape/)
  })

  it("skips a single unreadable record instead of losing the page", async () => {
    // Genau der Fall aus der Produktion: Google liefert bei einem Eintrag
    // keine addressComponents[].types. Vorher fiel dadurch die komplette
    // Antwort durch die Validierung und die Suche endete bei null Firmen.
    const adapter = makeAdapter(
      fakeFetch(
        JSON.stringify({
          places: [
            { noId: true },
            {
              id: "places/ok",
              displayName: { text: "Gasthaus Krone" },
              formattedAddress: "Landstrasse 1, 4020 Linz",
              addressComponents: [{ longText: "Linz" }],
            },
          ],
        })
      )
    )

    const result = await adapter.search(linzSpec)
    expect(result.entities).toHaveLength(1)
    expect(result.entities[0]?.name).toBe("Gasthaus Krone")
  })

  it("fails loudly when no record at all is readable", async () => {
    // Ein Ausfall ist ein Einzelfall, zwanzig sind eine Formataenderung -
    // die soll auffallen statt still zu null Treffern zu fuehren.
    const adapter = makeAdapter(
      fakeFetch(JSON.stringify({ places: [{ noId: true }, { alsoNoId: true }] }))
    )
    await expect(adapter.search(linzSpec)).rejects.toThrow(/kein einziger/)
  })
})

describe("PlacesAdapter.estimateCost", () => {
  it("reports a real monetary cost", () => {
    const estimate = makeAdapter(fakeFetch("{}")).estimateCost(linzSpec)
    expect(estimate.estimatedCostEur).toBeGreaterThan(0)
  })

  it("warns when the limit exceeds what Places can return", () => {
    // 500 requested, 60 reachable - saying so avoids a silent shortfall.
    const estimate = makeAdapter(fakeFetch("{}")).estimateCost({ ...linzSpec, limit: 500 })
    expect(estimate.estimatedEntities).toBe(60)
    expect(estimate.notes?.join(" ")).toContain("maximal 60")
  })

  it("flags filters it cannot push down", () => {
    const estimate = makeAdapter(fakeFetch("{}")).estimateCost({
      targetType: "local_business",
      filters: {
        op: "and",
        children: [
          { op: "eq", key: "core.category", value: "Restaurant" },
          { op: "eq", key: "web.presence.has_website", value: false },
        ],
      },
    })
    expect(estimate.degraded).toBe(true)
  })
})

describe("estimatePlacesCost", () => {
  it("charges per page, not per result", () => {
    const one = estimatePlacesCost({ limit: 20, withDetails: false })
    const two = estimatePlacesCost({ limit: 40, withDetails: false })

    expect(one.pages).toBe(1)
    expect(two.pages).toBe(2)
    // Precision 3: the reported figure is rounded to four decimals, so doubling
    // it does not land exactly on twice the rounded value.
    expect(two.costEur).toBeCloseTo(one.costEur * 2, 3)
  })

  it("caps at the maximum number of pages Places serves", () => {
    const estimate = estimatePlacesCost({ limit: 1000, withDetails: false })
    expect(estimate.pages).toBe(CURRENT_PLACES_PRICING.maxPages)
  })

  it("shows that details dominate the bill", () => {
    const without = estimatePlacesCost({ limit: 60, withDetails: false })
    const withDetails = estimatePlacesCost({ limit: 60, withDetails: true })
    expect(withDetails.costEur).toBeGreaterThan(without.costEur * 5)
  })
})

describe("planPlacesQuery", () => {
  it("caps the radius at the Places limit of 50 km", () => {
    const plan = planPlacesQuery({
      targetType: "local_business",
      filters: { op: "within", key: "core.geo", value: { lat: 48, lon: 14, radiusMetres: 900000 } },
    })
    expect(plan.locationBias?.circle.radius).toBe(50_000)
  })

  it("converts a bbox into a circle", () => {
    const plan = planPlacesQuery({
      targetType: "local_business",
      filters: { op: "within", key: "core.geo", value: { bbox: [48.28, 14.25, 48.33, 14.33] } },
    })
    expect(plan.locationBias?.circle.center.latitude).toBeCloseTo(48.305, 3)
    expect(plan.locationBias?.circle.radius).toBeGreaterThan(0)
  })

  it("post-filters an OR branch", () => {
    const plan = planPlacesQuery({
      targetType: "local_business",
      filters: {
        op: "or",
        children: [
          { op: "eq", key: "core.city", value: "Linz" },
          { op: "eq", key: "core.city", value: "Wels" },
        ],
      },
    })
    expect(plan.textQuery).toBe("")
    expect(plan.unsupported).toStrictEqual(["core.city", "core.city"])
  })
})

describe("toRawEntity", () => {
  it("returns null without a name", () => {
    expect(toRawEntity({ id: "x" })).toBeNull()
  })

  it("returns null for a permanently closed place", () => {
    expect(
      toRawEntity({
        id: "x",
        displayName: { text: "Zu" },
        businessStatus: "CLOSED_PERMANENTLY",
      })
    ).toBeNull()
  })

  it("keeps the raw payload for later re-normalization", () => {
    const entity = toRawEntity({ id: "x", displayName: { text: "Test" }, rating: 4.5 })
    expect(entity?.raw).toMatchObject({ id: "x", rating: 4.5 })
  })
})

describe("the request body Google actually accepts", () => {
  it("sends a circle as locationBias, never as locationRestriction", async () => {
    // Die Text-Search-API akzeptiert bei locationRestriction ausschliesslich ein
    // Rechteck. Wir bauen aus der bbox einen Kreis - als restriction geschickt
    // ergab das HTTP 400 bei jeder Suche mit Geo-Filter.
    const fetchImpl = fakeFetch(JSON.stringify({ places: [] }))
    await makeAdapter(fetchImpl).search({
      targetType: "local_business",
      filters: {
        op: "and",
        children: [
          { op: "eq", key: "core.category", value: "restaurant" },
          { op: "within", key: "core.geo", value: { bbox: [48.1, 13.95, 48.35, 14.4] } },
        ],
      },
    })

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body ?? "{}"))
    expect(body.locationBias?.circle).toBeDefined()
    expect(body.locationRestriction).toBeUndefined()
  })

  it("names Googles error status, not just the HTTP code", async () => {
    // "responded with 400" macht einen Konfigurationsfehler von einem falsch
    // gebauten Request ununterscheidbar. INVALID_ARGUMENT sagt "wir bauen den
    // Request falsch", PERMISSION_DENIED "der Schluessel stimmt nicht".
    const fetchImpl = fakeFetch(
      JSON.stringify({
        error: { status: "INVALID_ARGUMENT", message: "Invalid location restriction." },
      }),
      400
    )

    await expect(
      makeAdapter(fetchImpl).search({
        targetType: "local_business",
        filters: { op: "eq", key: "core.category", value: "restaurant" },
      })
    ).rejects.toThrow(/400 \(INVALID_ARGUMENT\)/)
  })

  it("leaves error.message out entirely, because Google puts the key in it", async () => {
    // Nicht hypothetisch: Google antwortet mit "API key not valid: AIza...".
    // Deshalb nur der Enum-Wert, nie der Freitext.
    const fetchImpl = fakeFetch(
      JSON.stringify({
        error: { status: "PERMISSION_DENIED", message: "API key not valid: AIzaSyGEHEIM" },
      }),
      403
    )

    const attempt = () =>
      makeAdapter(fetchImpl).search({
        targetType: "local_business",
        filters: { op: "eq", key: "core.category", value: "restaurant" },
      })

    await expect(attempt()).rejects.toThrow(/PERMISSION_DENIED/)
    await expect(attempt()).rejects.not.toThrow(/AIzaSyGEHEIM/)
  })

  it("stays usable when the error body is not JSON at all", async () => {
    const fetchImpl = fakeFetch("<html>502 Bad Gateway</html>", 502)
    await expect(
      makeAdapter(fetchImpl).search({
        targetType: "local_business",
        filters: { op: "eq", key: "core.category", value: "restaurant" },
      })
    ).rejects.toThrow(/502/)
  })
})
