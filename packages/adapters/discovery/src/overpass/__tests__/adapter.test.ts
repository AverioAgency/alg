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
  })
}

describe("OverpassAdapter", () => {
  it("declares itself for local_business only", () => {
    const adapter = makeAdapter(fakeFetch("{}"))
    expect(adapter.targetTypes).toStrictEqual(["local_business"])
    expect(adapter.supports).toContain("core.geo")
    expect(adapter.supports).toContain("core.category")
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
