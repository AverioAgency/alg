import { describe, expect, it } from "vitest"
import { type FilterNode } from "@alg/shared"
import { escapeOverpassValue, planOverpassQuery, renderOverpassQl } from "../query.js"

describe("planOverpassQuery", () => {
  it("pushes down a bbox", () => {
    const plan = planOverpassQuery(
      { op: "within", key: "core.geo", value: { bbox: [48.28, 14.25, 48.33, 14.33] } },
      100
    )
    expect(plan.area.bbox).toStrictEqual([48.28, 14.25, 48.33, 14.33])
    expect(plan.unsupported).toStrictEqual([])
  })

  it("pushes down a radius search", () => {
    const plan = planOverpassQuery(
      { op: "within", key: "core.geo", value: { lat: 48.3, lon: 14.28, radiusMetres: 5000 } },
      100
    )
    expect(plan.area.around).toStrictEqual({ lat: 48.3, lon: 14.28, radiusMetres: 5000 })
  })

  it("maps a known category onto OSM tags", () => {
    const plan = planOverpassQuery({ op: "eq", key: "core.category", value: "restaurant" }, 100)
    expect(plan.tagFilters).toStrictEqual(['["amenity"="restaurant"]'])
  })

  it("maps a category with several OSM equivalents", () => {
    const plan = planOverpassQuery({ op: "eq", key: "core.category", value: "hardware" }, 100)
    expect(plan.tagFilters).toStrictEqual(['["shop"="hardware"]', '["shop"="doityourself"]'])
  })

  it("reports an unknown category as unsupported instead of silently dropping it", () => {
    // Silently ignoring it would return every business in the area, which looks
    // like a working search but is the wrong result.
    const plan = planOverpassQuery({ op: "eq", key: "core.category", value: "raumfahrt" }, 100)
    expect(plan.tagFilters).toStrictEqual([])
    expect(plan.unsupported).toContain("core.category")
  })

  it("marks keys it cannot serve for post-filtering", () => {
    const plan = planOverpassQuery(
      {
        op: "and",
        children: [
          { op: "within", key: "core.geo", value: { bbox: [48, 14, 49, 15] } },
          { op: "eq", key: "web.presence.has_website", value: false },
        ],
      },
      100
    )
    expect(plan.unsupported).toStrictEqual(["web.presence.has_website"])
  })

  it("does not push down an OR branch", () => {
    // Overpass selectors are an AND of tag conditions; an OR must be evaluated
    // on our side or the result would be wrong.
    const filters: FilterNode = {
      op: "or",
      children: [
        { op: "eq", key: "core.city", value: "Linz" },
        { op: "eq", key: "core.city", value: "Wels" },
      ],
    }
    const plan = planOverpassQuery(filters, 100)
    expect(plan.tagFilters).toStrictEqual([])
    expect(plan.unsupported).toStrictEqual(["core.city", "core.city"])
  })

  it("does not push down a negated leaf", () => {
    const plan = planOverpassQuery(
      { op: "not", child: { op: "eq", key: "core.city", value: "Linz" } },
      100
    )
    expect(plan.tagFilters).toStrictEqual([])
    expect(plan.unsupported).toStrictEqual(["core.city"])
  })

  it("pushes down address tags", () => {
    const plan = planOverpassQuery(
      {
        op: "and",
        children: [
          { op: "eq", key: "core.city", value: "Linz" },
          { op: "eq", key: "core.postal_code", value: "4020" },
          { op: "eq", key: "core.country", value: "AT" },
        ],
      },
      100
    )
    expect(plan.tagFilters).toStrictEqual([
      '["addr:city"="Linz"]',
      '["addr:postcode"="4020"]',
      '["addr:country"="AT"]',
    ])
  })

  it("uses a case-insensitive regex for a contains match on the name", () => {
    const plan = planOverpassQuery({ op: "contains", key: "core.name", value: "Gasthaus" }, 100)
    expect(plan.tagFilters).toStrictEqual(['["name"~"Gasthaus",i]'])
  })
})

describe("escapeOverpassValue", () => {
  it("escapes quotes and backslashes so a value cannot break out of the string", () => {
    expect(escapeOverpassValue('Muster "Test"')).toBe('Muster \\"Test\\"')
    expect(escapeOverpassValue("back\\slash")).toBe("back\\\\slash")
  })

  it("neutralizes an injection attempt in a filter value", () => {
    const plan = planOverpassQuery(
      { op: "eq", key: "core.city", value: 'Linz"];out;node["amenity"="x' },
      100
    )
    // The injected quote is escaped, so the whole payload stays one QL string.
    expect(plan.tagFilters[0]).toBe('["addr:city"="Linz\\"];out;node[\\"amenity\\"=\\"x"]')
  })
})

describe("renderOverpassQl", () => {
  it("renders a complete query", () => {
    const plan = planOverpassQuery(
      {
        op: "and",
        children: [
          { op: "eq", key: "core.category", value: "restaurant" },
          { op: "within", key: "core.geo", value: { bbox: [48.28, 14.25, 48.33, 14.33] } },
        ],
      },
      25
    )
    const ql = renderOverpassQl(plan, 60)

    expect(ql).toContain("[out:json][timeout:60];")
    expect(ql).toContain('node["amenity"="restaurant"](48.28,14.25,48.33,14.33);')
    expect(ql).toContain('way["amenity"="restaurant"](48.28,14.25,48.33,14.33);')
    expect(ql).toContain('relation["amenity"="restaurant"](48.28,14.25,48.33,14.33);')
    expect(ql).toContain("out center 25;")
  })

  it("renders a radius query", () => {
    const plan = planOverpassQuery(
      { op: "within", key: "core.geo", value: { lat: 48.3, lon: 14.28, radiusMetres: 5000 } },
      10
    )
    expect(renderOverpassQl(plan)).toContain("(around:5000,48.3,14.28)")
  })

  it("unions several category selectors rather than intersecting them", () => {
    // shop=hardware AND shop=doityourself would match nothing at all.
    const plan = planOverpassQuery({ op: "eq", key: "core.category", value: "hardware" }, 10)
    const ql = renderOverpassQl(plan)

    expect(ql).toContain('node["shop"="hardware"]')
    expect(ql).toContain('node["shop"="doityourself"]')
    expect(ql).not.toContain('["shop"="hardware"]["shop"="doityourself"]')
  })

  it("combines a category selector with address filters", () => {
    const plan = planOverpassQuery(
      {
        op: "and",
        children: [
          { op: "eq", key: "core.category", value: "restaurant" },
          { op: "eq", key: "core.city", value: "Linz" },
          { op: "within", key: "core.geo", value: { bbox: [48, 14, 49, 15] } },
        ],
      },
      10
    )
    expect(renderOverpassQl(plan)).toContain('node["amenity"="restaurant"]["addr:city"="Linz"]')
  })
})
