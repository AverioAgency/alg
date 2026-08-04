import { describe, expect, it } from "vitest"
import { CATEGORY_SLUGS, categoriesFor, type FilterNode } from "@alg/shared"
import {
  escapeOverpassValue,
  knownCategories,
  knownCompanyCategories,
  planOverpassQuery,
  renderOverpassQl,
} from "../query.js"

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

  it("leaves the city to the post-filter but pushes down postcode and country", () => {
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
    // Der Ort fehlt hier bewusst: addr:city ist in OSM oft nicht gesetzt, und
    // an der Quelle zu filtern verwarf brauchbare Treffer (61s/4 statt 3s/15).
    expect(plan.unsupported).toContain("core.city")
    expect(plan.tagFilters).toStrictEqual([
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

  it("never sends addr:city, whatever the operator", () => {
    /**
     * Gemessen fuer "Elektro" in Oberoesterreich: mit ["addr:city"="Linz"]
     * kamen nach 61s vier Treffer, ohne den Tag nach 3s fuenfzehn - dieselben
     * Betriebe plus die, denen niemand das Tag eingetragen hat. Das Feld ist in
     * OSM weder verlaesslich gefuellt noch indiziert.
     *
     * pushTag ignorierte ausserdem den Operator: ein `contains` wurde zur
     * Gleichheit, "Linz-Urfahr" fiel damit durch eine Suche nach "Linz".
     */
    for (const op of ["eq", "contains"] as const) {
      const plan = planOverpassQuery({ op, key: "core.city", value: "Linz" }, 100)
      expect(plan.tagFilters.join(" ")).not.toContain("addr:city")
      expect(plan.unsupported).toContain("core.city")
    }
  })

  it("neutralizes an injection attempt in a filter value", () => {
    // core.name statt core.city: der Ort geht seit der addr:city-Messung in den
    // Nachfilter, der Name wird weiterhin an die Quelle gereicht.
    const plan = planOverpassQuery(
      { op: "eq", key: "core.name", value: 'Elektro"];out;node["amenity"="x' },
      100
    )
    // The injected quote is escaped, so the whole payload stays one QL string.
    expect(plan.tagFilters[0]).toBe('["name"="Elektro\\"];out;node[\\"amenity\\"=\\"x"]')
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

  it("combines a category selector with the address filters it can push down", () => {
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
    // Der Ort steht nicht mehr in der Abfrage: addr:city ist in OSM oft nicht
    // gesetzt, und an der Quelle zu filtern verwarf brauchbare Treffer
    // (gemessen 61s/4 Treffer statt 3s/15). Der Nachfilter hat die Koordinate.
    const ql = renderOverpassQl(plan)
    expect(ql).toContain('node["amenity"="restaurant"]')
    expect(ql).not.toContain("addr:city")
  })
})

/**
 * The company vocabulary, added in M4.
 *
 * Category names and tag mappings were checked against the live Overpass API for
 * the Linz/Wels area: office=* returns 635 objects, craft=* 246, man_made=works
 * 462. Enough to be worth searching, thin enough that a company search is a seed
 * list rather than a register.
 */
describe("company categories", () => {
  it("maps the broad company category onto office tags", () => {
    const plan = planOverpassQuery({ op: "eq", key: "core.category", value: "company" }, 100)
    expect(plan.tagFilters).toStrictEqual(['["office"="company"]', '["office"="commercial"]'])
  })

  it("emits a bare key selector for a category that matches any value", () => {
    // craft=* is the point: the OSM value is the trade itself (craft=carpenter,
    // craft=electrician), so the bare key is what "Handwerksbetriebe" means.
    // Enumerating the ~70 documented values would go stale on the next wiki edit.
    const plan = planOverpassQuery({ op: "eq", key: "core.category", value: "craft_business" }, 100)
    expect(plan.tagFilters).toStrictEqual(['["craft"]'])
    expect(renderOverpassQl(plan)).toContain('node["craft"]')
  })

  it("covers production sites through several tags at once", () => {
    const plan = planOverpassQuery({ op: "eq", key: "core.category", value: "industrial" }, 100)
    expect(plan.tagFilters).toStrictEqual(['["man_made"="works"]', '["building"="industrial"]'])
  })

  it("unions company selectors instead of intersecting them", () => {
    // The bug this guards against: renderOverpassQl used to decide what was a
    // category by matching the tag name against a fixed list. man_made and
    // landuse were not on it, so an industrial search silently became an AND of
    // two tags and matched nothing.
    const plan = planOverpassQuery({ op: "eq", key: "core.category", value: "industrial" }, 10)
    const ql = renderOverpassQl(plan)

    expect(ql).toContain('node["man_made"="works"]')
    expect(ql).toContain('node["building"="industrial"]')
    expect(ql).not.toContain('["man_made"="works"]["building"="industrial"]')
  })

  it("combines a company category with a postcode filter", () => {
    const plan = planOverpassQuery(
      {
        op: "and",
        children: [
          { op: "eq", key: "core.category", value: "craft_business" },
          { op: "eq", key: "core.city", value: "Wels" },
          { op: "within", key: "core.geo", value: { bbox: [48, 13.9, 48.4, 14.4] } },
        ],
      },
      10
    )
    // Die Kategorie unioniert weiterhin; der Ort wird nachgelagert geprueft.
    const ql = renderOverpassQl(plan)
    expect(ql).toContain('node["craft"]')
    expect(ql).not.toContain("addr:city")
  })

  it("searches several company categories at once", () => {
    const plan = planOverpassQuery(
      { op: "in", key: "core.category", value: ["craft_business", "industrial"] },
      10
    )
    const ql = renderOverpassQl(plan)

    expect(ql).toContain('node["craft"]')
    expect(ql).toContain('node["man_made"="works"]')
    expect(ql).toContain('node["building"="industrial"]')
  })

  it("keeps the local business vocabulary working alongside it", () => {
    // Both tables are consulted, so adding companies must not shadow a shop.
    const plan = planOverpassQuery({ op: "eq", key: "core.category", value: "bakery" }, 100)
    expect(plan.tagFilters).toStrictEqual(['["shop"="bakery"]'])
  })

  it("reports an unknown company category as unsupported", () => {
    const plan = planOverpassQuery(
      { op: "eq", key: "core.category", value: "raumfahrttechnik" },
      10
    )
    expect(plan.tagFilters).toStrictEqual([])
    expect(plan.unsupported).toContain("core.category")
  })

  it("lists the company categories for the filter UI", () => {
    expect(knownCompanyCategories()).toContain("craft_business")
    expect(knownCompanyCategories()).toContain("industrial")
    // The local business vocabulary is a separate list.
    expect(knownCompanyCategories()).not.toContain("restaurant")
  })

  it("knownCategories covers both vocabularies", () => {
    expect(knownCategories()).toContain("restaurant")
    expect(knownCategories()).toContain("craft_business")
  })
})

describe("the category vocabulary and its OSM mapping", () => {
  /**
   * Two lists in two packages: the neutral vocabulary in @alg/shared, which the
   * filter UI and every saved SearchSpec use, and the OSM tag mapping here. They
   * are separate on purpose - Google Places maps the same slugs onto a text
   * query - but they must not drift apart, so this is the seam that gets tested.
   */
  it("maps every category the UI offers onto OSM tags", () => {
    const mappable = new Set(knownCategories())
    const missing = CATEGORY_SLUGS.filter((slug) => !mappable.has(slug))

    // A slug the UI offers but Overpass cannot serve would look like a working
    // filter and silently return every business in the area.
    expect(missing).toStrictEqual([])
  })

  it("offers every mapped category in the vocabulary", () => {
    // The other direction: a tag mapping nobody can pick is dead code.
    const offered = new Set(CATEGORY_SLUGS)
    const orphaned = knownCategories().filter((slug) => !offered.has(slug))

    expect(orphaned).toStrictEqual([])
  })

  it("agrees with the vocabulary on which categories are for companies", () => {
    const companySlugs = categoriesFor("company").map((category) => category.slug)
    expect([...knownCompanyCategories()].sort()).toStrictEqual([...companySlugs].sort())
  })
})

/**
 * Die offene Suche - ohne gewaehlte Branche.
 *
 * Der teuerste Fall gegen Overpass, und der, der in Produktion minutenlang
 * haengengeblieben ist. Gemessen fuer Oberoesterreich: ohne Selektor scheitert
 * die Abfrage nach 8-13s serverseitig, dieselbe Abfrage ueber den Raum
 * Linz/Wels liefert in 6s 500 Objekte.
 */
describe("a search with no category chosen", () => {
  const bbox = (b: [number, number, number, number]): FilterNode => ({
    op: "within",
    key: "core.geo",
    value: { bbox: b },
  })

  it("never emits a bare selector", () => {
    // `node(bbox)` allein holt jeden Baum und jede Laterne - Millionen Objekte,
    // an denen der Server abbricht.
    const plan = planOverpassQuery({ op: "and", children: [bbox([48, 14, 48.3, 14.4])] }, 100)
    const ql = renderOverpassQl(plan)

    expect(ql).not.toMatch(/^\s+node\(/m)
    expect(ql).not.toMatch(/^\s+way\(/m)
  })

  it("searches the tags that actually carry a business", () => {
    const plan = planOverpassQuery({ op: "and", children: [bbox([48, 14, 48.3, 14.4])] }, 100)
    const ql = renderOverpassQl(plan)

    for (const tag of ["shop", "amenity", "craft", "office", "tourism"]) {
      expect(ql).toContain(`node["${tag}"]`)
    }
  })

  it('does not fall back to ["name"]', () => {
    // Gemessen die schlechteste Option von allen: 105s gegen einen Mirror,
    // weil jede benannte Strasse und jeder Ort mitmatcht.
    const plan = planOverpassQuery({ op: "and", children: [bbox([48, 14, 48.3, 14.4])] }, 100)
    expect(renderOverpassQl(plan)).not.toContain('["name"]')
  })

  it("keeps a chosen category exactly as it is", () => {
    // Die Ersatzliste darf nur greifen, wenn wirklich nichts gewaehlt wurde.
    const plan = planOverpassQuery(
      {
        op: "and",
        children: [bbox([48, 14, 48.3, 14.4]), { op: "eq", key: "core.category", value: "bakery" }],
      },
      100
    )
    const ql = renderOverpassQl(plan)

    expect(ql).toContain('node["shop"="bakery"]')
    expect(ql).not.toContain('node["amenity"]')
  })
})
