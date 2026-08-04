import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"
import { type SearchSpec } from "@alg/shared"
import { OverpassAdapter, toRawEntity } from "../adapter.js"

/**
 * Contract test against a recorded Overpass response. No live call - the fixture
 * is what pins the adapter's behaviour, and a change in the upstream shape should
 * be a deliberate fixture update rather than a surprise in production.
 */

const FIXTURES = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures")

async function loadFixture(name: string): Promise<string> {
  return readFile(join(FIXTURES, name), "utf8")
}

function fakeFetch(body: string, status = 200) {
  return vi.fn(async () => ({
    status,
    headers: new Headers(),
    body,
    url: "https://overpass-api.de/api/interpreter",
  }))
}

const linzSpec: SearchSpec = {
  targetType: "local_business",
  filters: {
    op: "and",
    children: [
      { op: "eq", key: "core.category", value: "restaurant" },
      {
        op: "within",
        key: "core.geo",
        value: { bbox: [48.28, 14.25, 48.33, 14.33] },
      },
    ],
  },
  limit: 50,
}

function makeAdapter(fetchImpl: ReturnType<typeof fakeFetch>) {
  return new OverpassAdapter({
    endpoint: "https://overpass-api.de/api/interpreter",
    userAgent: "AlgBot/1.0 (+https://averio.agency/bot)",
    fetchImpl: fetchImpl as never,
    // No mirrors and no waiting: the retry behaviour has its own tests below,
    // and the rest of the suite should not sit through real backoff delays.
    fallbackEndpoints: [],
    maxAttempts: 1,
    sleep: async () => undefined,
  })
}

describe("OverpassAdapter", () => {
  it("declares itself for local businesses and companies", () => {
    // Companies were added in M4. OSM maps them less completely than shops, so
    // a company search is a seed list to enrich rather than a register - but
    // that is a coverage caveat, not a reason to refuse the target type.
    const adapter = makeAdapter(fakeFetch("{}"))
    expect(adapter.targetTypes).toStrictEqual(["local_business", "company"])
    expect(adapter.supports).toContain("core.geo")
    expect(adapter.supports).toContain("core.category")
  })

  it("stamps entities with the target type the search asked for", async () => {
    // The same OSM object is a local_business in one search and a company in
    // another. Hardcoding local_business here would have made every company
    // search produce records that dedupe and filter as the wrong type.
    const fetchImpl = fakeFetch(await loadFixture("linz-restaurants.json"))
    const { entities } = await makeAdapter(fetchImpl).search({
      ...linzSpec,
      targetType: "company",
      filters: {
        op: "and",
        children: [
          { op: "eq", key: "core.category", value: "craft_business" },
          { op: "within", key: "core.geo", value: { bbox: [48.28, 14.25, 48.33, 14.33] } },
        ],
      },
    })

    expect(entities.length).toBeGreaterThan(0)
    expect(entities.every((entity) => entity.targetType === "company")).toBe(true)
  })

  it("defaults to local_business, so existing searches are unaffected", async () => {
    const fetchImpl = fakeFetch(await loadFixture("linz-restaurants.json"))
    const { entities } = await makeAdapter(fetchImpl).search(linzSpec)

    expect(entities.every((entity) => entity.targetType === "local_business")).toBe(true)
  })

  it("normalizes a recorded response into RawEntities", async () => {
    const fetchImpl = fakeFetch(await loadFixture("linz-restaurants.json"))
    const { entities } = await makeAdapter(fetchImpl).search(linzSpec)

    // Five elements in, four out: the unnamed restaurant is not a lead.
    expect(entities).toHaveLength(4)
    expect(entities.every((e) => e.source === "overpass")).toBe(true)
    expect(entities.every((e) => e.targetType === "local_business")).toBe(true)
  })

  it("maps a node with full tags", async () => {
    const fetchImpl = fakeFetch(await loadFixture("linz-restaurants.json"))
    const { entities } = await makeAdapter(fetchImpl).search(linzSpec)

    const post = entities.find((e) => e.name === "Gasthaus Zur Post")
    expect(post).toBeDefined()
    expect(post?.sourceId).toBe("node/246819820")
    expect(post?.address?.postal_code).toBe("4020")
    expect(post?.address?.city).toBe("Linz")
    expect(post?.geo).toStrictEqual({ lat: 48.3060537, lon: 14.2865461 })
    expect(post?.website).toBe("https://www.gasthaus-zur-post.at")
    expect(post?.phone).toBe("+43 732 771234")
  })

  it("uses the center point for ways and relations", async () => {
    const fetchImpl = fakeFetch(await loadFixture("linz-restaurants.json"))
    const { entities } = await makeAdapter(fetchImpl).search(linzSpec)

    const bistro = entities.find((e) => e.name === "Bistro Beispiel")
    expect(bistro?.sourceId).toBe("way/118273645")
    expect(bistro?.geo).toStrictEqual({ lat: 48.3011234, lon: 14.2912345 })
  })

  it("reads contact: prefixed tags as well as plain ones", async () => {
    const fetchImpl = fakeFetch(await loadFixture("linz-restaurants.json"))
    const { entities } = await makeAdapter(fetchImpl).search(linzSpec)

    const bistro = entities.find((e) => e.name === "Bistro Beispiel")
    expect(bistro?.email).toBe("office@bistro-beispiel.at")
    expect(bistro?.phone).toBe("0732/998877")
  })

  it("keeps the untouched tags for later re-normalization", async () => {
    const fetchImpl = fakeFetch(await loadFixture("linz-restaurants.json"))
    const { entities } = await makeAdapter(fetchImpl).search(linzSpec)

    const post = entities.find((e) => e.name === "Gasthaus Zur Post")
    expect(post?.raw).toMatchObject({ cuisine: "austrian", osm_type: "node", osm_id: 246819820 })
  })

  it("posts Overpass QL containing the bbox and the mapped category", async () => {
    const fetchImpl = fakeFetch(await loadFixture("linz-restaurants.json"))
    await makeAdapter(fetchImpl).search(linzSpec)

    const body = String(fetchImpl.mock.calls[0]?.[1]?.body ?? "")
    const decoded = decodeURIComponent(body)
    expect(decoded).toContain("amenity")
    expect(decoded).toContain("restaurant")
    expect(decoded).toContain("48.28,14.25,48.33,14.33")
    expect(decoded).toContain("out center 50")
  })

  it("queries node, way and relation", async () => {
    const fetchImpl = fakeFetch(await loadFixture("linz-restaurants.json"))
    await makeAdapter(fetchImpl).search(linzSpec)

    const decoded = decodeURIComponent(String(fetchImpl.mock.calls[0]?.[1]?.body ?? ""))
    expect(decoded).toContain("node")
    expect(decoded).toContain("way")
    expect(decoded).toContain("relation")
  })

  it("refuses a search without a geographic constraint", async () => {
    const adapter = makeAdapter(fakeFetch("{}"))
    await expect(
      adapter.search({
        targetType: "local_business",
        filters: { op: "eq", key: "core.category", value: "restaurant" },
      })
    ).rejects.toThrow(/geographic constraint/)
  })

  it("surfaces an upstream error rather than returning nothing", async () => {
    const adapter = makeAdapter(fakeFetch("gateway timeout", 504))
    await expect(adapter.search(linzSpec)).rejects.toThrow(/504/)
  })

  it("rejects a response that is not the expected shape", async () => {
    const adapter = makeAdapter(fakeFetch(JSON.stringify({ unexpected: true })))
    await expect(adapter.search(linzSpec)).rejects.toThrow(/unexpected shape/)
  })

  it("rejects a body that is not JSON", async () => {
    const adapter = makeAdapter(fakeFetch("<html>rate limited</html>"))
    await expect(adapter.search(linzSpec)).rejects.toThrow(/not JSON/)
  })
})

describe("OverpassAdapter resilience", () => {
  /** Returns the given responses in order, so a retry sees a different one. */
  function sequencedFetch(responses: { status: number; body: string }[]) {
    let call = 0
    const impl = vi.fn(async () => {
      const response = responses[Math.min(call, responses.length - 1)]
      call++
      return {
        status: response?.status ?? 500,
        headers: new Headers(),
        body: response?.body ?? "",
        url: "https://overpass",
      }
    })
    return impl
  }

  function resilientAdapter(fetchImpl: ReturnType<typeof sequencedFetch>) {
    return new OverpassAdapter({
      endpoint: "https://primary.test/api/interpreter",
      userAgent: "AlgBot/1.0",
      fetchImpl: fetchImpl as never,
      fallbackEndpoints: ["https://mirror.test/api/interpreter"],
      maxAttempts: 2,
      sleep: async () => undefined,
    })
  }

  it("retries a 504 rather than reporting an empty result", async () => {
    // This is what actually happened in production: the public instance timed
    // out, the run reported zero entities, and it looked like an empty area.
    const fixture = await loadFixture("linz-restaurants.json")
    const fetchImpl = sequencedFetch([
      { status: 504, body: "<!DOCTYPE html><html>gateway timeout</html>" },
      { status: 200, body: fixture },
    ])

    const { entities } = await resilientAdapter(fetchImpl).search(linzSpec)

    expect(entities).toHaveLength(4)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("retries 429, which the public instance uses for rate limiting", async () => {
    const fixture = await loadFixture("linz-restaurants.json")
    const fetchImpl = sequencedFetch([
      { status: 429, body: "too many requests" },
      { status: 200, body: fixture },
    ])

    await expect(resilientAdapter(fetchImpl).search(linzSpec)).resolves.toBeDefined()
  })

  it("falls back to a mirror once the primary is exhausted", async () => {
    const fixture = await loadFixture("linz-restaurants.json")
    const fetchImpl = sequencedFetch([
      { status: 504, body: "busy" },
      { status: 504, body: "busy" },
      { status: 200, body: fixture },
    ])

    const { entities } = await resilientAdapter(fetchImpl).search(linzSpec)

    expect(entities).toHaveLength(4)
    // Two attempts against the primary, then the mirror.
    expect(fetchImpl.mock.calls[2]?.[0]).toBe("https://mirror.test/api/interpreter")
  })

  it("does not retry a client error", async () => {
    // A malformed query will not become valid by asking again.
    const fetchImpl = sequencedFetch([{ status: 400, body: "bad request" }])

    await expect(resilientAdapter(fetchImpl).search(linzSpec)).rejects.toThrow()
    // One call per endpoint, no repeat against the same one.
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("names every endpoint it tried when all of them fail", async () => {
    const fetchImpl = sequencedFetch([{ status: 504, body: "busy" }])

    await expect(resilientAdapter(fetchImpl).search(linzSpec)).rejects.toThrow(
      /primary\.test.*mirror\.test/s
    )
  })

  it("moves to the next endpoint when the network itself fails", async () => {
    const fixture = await loadFixture("linz-restaurants.json")
    let call = 0
    const fetchImpl = vi.fn(async () => {
      call++
      if (call === 1) throw new Error("ENOTFOUND")
      return { status: 200, headers: new Headers(), body: fixture, url: "https://mirror" }
    })

    const adapter = new OverpassAdapter({
      endpoint: "https://primary.test/api/interpreter",
      userAgent: "AlgBot/1.0",
      fetchImpl: fetchImpl as never,
      fallbackEndpoints: ["https://mirror.test/api/interpreter"],
      maxAttempts: 2,
      sleep: async () => undefined,
    })

    const { entities } = await adapter.search(linzSpec)
    expect(entities).toHaveLength(4)
    // An unreachable host is not worth a second attempt; move on immediately.
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("gives a mirror less time than the primary endpoint", async () => {
    // Gemessen haengen beide Mirrors ohne ein einziges Byte, bis jemand
    // abbricht. Mit demselben Zeitlimit wie der Hauptendpunkt wartet der
    // Nutzer zweimal 45s auf Hosts, die nichts liefern werden.
    const fixture = await loadFixture("linz-restaurants.json")
    const fetchImpl = sequencedFetch([
      { status: 504, body: "busy" },
      { status: 504, body: "busy" },
      { status: 200, body: fixture },
    ])

    await resilientAdapter(fetchImpl).search(linzSpec)

    const primaryTimeout = (fetchImpl.mock.calls[0]?.[1] as { timeoutMs: number }).timeoutMs
    const mirrorTimeout = (fetchImpl.mock.calls[2]?.[1] as { timeoutMs: number }).timeoutMs
    expect(mirrorTimeout).toBeLessThan(primaryTimeout)
  })

  it("leaves Overpass room to answer before our own timeout fires", async () => {
    // Beide bei 45s hiess: wir brechen genau dann ab, wenn der Server seine
    // Antwort - und sei es eine Fehlermeldung - schicken wuerde. Ein
    // serverseitiger Abbruch nennt den Grund, unserer sagt nur "aborted".
    const fetchImpl = sequencedFetch([
      { status: 200, body: await loadFixture("linz-restaurants.json") },
    ])

    await resilientAdapter(fetchImpl).search(linzSpec)

    const call = fetchImpl.mock.calls[0]?.[1] as { body: string; timeoutMs: number }
    const declared = /\[timeout:(\d+)\]/.exec(decodeURIComponent(call.body))?.[1]
    expect(Number(declared) * 1000).toBeLessThan(call.timeoutMs)
  })
})

describe("refusing a branch Overpass does not know", () => {
  // OSM hat kein Tag fuer "it_services". Ohne diese Pruefung faellt die Query
  // auf alle Geschaefte des Bundeslandes zurueck, um danach jedes Objekt zu
  // verwerfen - die teuerste Abfrage mit garantiert leerem Ergebnis, und der
  // Grund fuer 504er bei null Treffern.
  const unknownBranch: SearchSpec = {
    targetType: "local_business",
    filters: {
      op: "and",
      children: [
        { op: "eq", key: "core.category", value: "it_services" },
        { op: "within", key: "core.geo", value: { bbox: [48.0, 13.0, 48.7, 14.6] } },
      ],
    },
    limit: 50,
  }

  it("says so instead of searching everything", async () => {
    const fetchImpl = fakeFetch("{}")
    await expect(makeAdapter(fetchImpl).search(unknownBranch)).rejects.toThrow(/Branche/)
    // Vor allem: es geht keine Abfrage raus.
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("still allows an open search over a small area", async () => {
    // Ohne Branchenwunsch bleibt die offene Suche erlaubt - nur eine
    // *unbekannte* Branche ist ein Fehler.
    const fetchImpl = fakeFetch(await loadFixture("linz-restaurants.json"))
    await expect(
      makeAdapter(fetchImpl).search({
        targetType: "local_business",
        filters: { op: "within", key: "core.geo", value: { bbox: [48.28, 14.25, 48.33, 14.33] } },
        limit: 50,
      })
    ).resolves.toBeDefined()
  })
})

describe("OverpassAdapter.estimateCost", () => {
  it("reports zero cost - Overpass is free", () => {
    const estimate = makeAdapter(fakeFetch("{}")).estimateCost(linzSpec)
    expect(estimate.estimatedCostEur).toBe(0)
    expect(estimate.estimatedEntities).toBe(50)
  })

  it("flags a spec whose filters cannot all be pushed down", () => {
    const estimate = makeAdapter(fakeFetch("{}")).estimateCost({
      targetType: "local_business",
      filters: {
        op: "and",
        children: [
          { op: "within", key: "core.geo", value: { bbox: [48, 14, 49, 15] } },
          { op: "eq", key: "web.presence.has_website", value: false },
        ],
      },
    })

    expect(estimate.degraded).toBe(true)
    expect(estimate.notes?.join(" ")).toContain("web.presence.has_website")
  })
})

describe("toRawEntity", () => {
  it("falls back from name to operator to brand", () => {
    expect(
      toRawEntity({ type: "node", id: 1, lat: 48, lon: 14, tags: { operator: "Betreiber GmbH" } })
        ?.name
    ).toBe("Betreiber GmbH")

    expect(
      toRawEntity({ type: "node", id: 2, lat: 48, lon: 14, tags: { brand: "Markenname" } })?.name
    ).toBe("Markenname")
  })

  it("returns null when there is no name at all", () => {
    expect(
      toRawEntity({ type: "node", id: 3, lat: 48, lon: 14, tags: { amenity: "bench" } })
    ).toBeNull()
    expect(toRawEntity({ type: "node", id: 4, lat: 48, lon: 14 })).toBeNull()
  })

  it("omits the address when no address tag is present", () => {
    const entity = toRawEntity({ type: "node", id: 5, lat: 48, lon: 14, tags: { name: "X" } })
    expect(entity?.address).toBeUndefined()
  })

  it("collects the OSM classification tags as categories", () => {
    const entity = toRawEntity({
      type: "node",
      id: 6,
      lat: 48,
      lon: 14,
      tags: { name: "X", amenity: "restaurant", shop: "deli" },
    })
    expect(entity?.categories).toStrictEqual(["amenity=restaurant", "shop=deli"])
  })
})

describe("refusing a query Overpass cannot answer", () => {
  it("rejects an open search over a whole province before sending it", async () => {
    // Gemessen: ohne Branche scheitert Oberoesterreich (rund 3 Quadratgrad) nach
    // 8-13s serverseitig, auf jedem Endpunkt. Der Adapter probiert danach zwei
    // Mirrors durch - der Lauf haengt minutenlang und endet bei null Treffern.
    // Frueh mit einem umsetzbaren Hinweis zu scheitern ist besser.
    const adapter = makeAdapter(fakeFetch("{}"))

    await expect(
      adapter.search({
        targetType: "local_business",
        filters: {
          op: "and",
          children: [
            { op: "within", key: "core.geo", value: { bbox: [47.42, 12.75, 48.78, 15.0] } },
          ],
        },
      })
    ).rejects.toThrow(/zu groß/)
  })

  it("allows the same area once a category narrows it", async () => {
    // craft=* ueber ganz Oberoesterreich kam in 5s zurueck - die Grenze gilt nur
    // fuer die offene Suche.
    const fetchImpl = fakeFetch(await loadFixture("linz-restaurants.json"))
    const { entities } = await makeAdapter(fetchImpl).search({
      targetType: "local_business",
      filters: {
        op: "and",
        children: [
          { op: "within", key: "core.geo", value: { bbox: [47.42, 12.75, 48.78, 15.0] } },
          { op: "eq", key: "core.category", value: "restaurant" },
        ],
      },
    })

    expect(entities.length).toBeGreaterThan(0)
  })

  it("allows an open search over a city-sized area", async () => {
    // Raum Linz/Wels: 500 Objekte in 6s.
    const fetchImpl = fakeFetch(await loadFixture("linz-restaurants.json"))
    const { entities } = await makeAdapter(fetchImpl).search({
      targetType: "local_business",
      filters: {
        op: "and",
        children: [{ op: "within", key: "core.geo", value: { bbox: [48.1, 13.95, 48.35, 14.4] } }],
      },
    })

    expect(entities.length).toBeGreaterThan(0)
  })
})
