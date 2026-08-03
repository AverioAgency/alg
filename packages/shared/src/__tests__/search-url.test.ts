import { describe, expect, it } from "vitest"
import {
  decodeSearchSpec,
  encodeSearchSpec,
  encodeSearchSpecToQuery,
  MATCH_ALL,
  type FilterNode,
  type SearchSpec,
} from "../index.js"

/**
 * The contract is the round trip: decode(encode(spec)) equals spec.
 *
 * A readable URL that silently loses a filter is worse than an opaque one - it
 * looks correct and runs a different search - so most of these tests are about
 * the encoder refusing the readable form rather than about producing it.
 */

function roundTrip(spec: SearchSpec): SearchSpec | null {
  return decodeSearchSpec(encodeSearchSpec(spec)).spec
}

const linzCraft: SearchSpec = {
  targetType: "company",
  filters: {
    op: "and",
    children: [
      { op: "eq", key: "core.category", value: "craft_business" },
      { op: "eq", key: "core.city", value: "Linz" },
    ],
  },
  limit: 500,
}

describe("readable encoding", () => {
  it("renders a simple search as parameters a human can read", () => {
    const query = encodeSearchSpecToQuery(linzCraft)

    expect(query).toContain("target_type=company")
    expect(query).toContain("category=craft_business")
    expect(query).toContain("city=Linz")
    expect(query).toContain("limit=500")
    // The whole point: no opaque blob for the common shape.
    expect(query).not.toContain("q=")
  })

  it("round-trips a simple search", () => {
    expect(roundTrip(linzCraft)).toStrictEqual(linzCraft)
  })

  it("renders a bbox readably", () => {
    const spec: SearchSpec = {
      targetType: "local_business",
      filters: {
        op: "and",
        children: [{ op: "within", key: "core.geo", value: { bbox: [48.1, 13.9, 48.35, 14.4] } }],
      },
    }

    expect(encodeSearchSpecToQuery(spec)).toContain("bbox=48.1%2C13.9%2C48.35%2C14.4")
    expect(roundTrip(spec)).toStrictEqual(spec)
  })

  it("renders a radius search readably", () => {
    const spec: SearchSpec = {
      targetType: "local_business",
      filters: {
        op: "and",
        children: [
          {
            op: "within",
            key: "core.geo",
            value: { lat: 48.3, lon: 14.28, radiusMetres: 5000 },
          },
        ],
      },
    }

    const query = encodeSearchSpecToQuery(spec)
    expect(query).toContain("lat=48.3")
    expect(query).toContain("radius=5000")
    expect(roundTrip(spec)).toStrictEqual(spec)
  })

  it("renders a multi-value filter as a comma list", () => {
    const spec: SearchSpec = {
      targetType: "company",
      filters: {
        op: "and",
        children: [{ op: "in", key: "core.category", value: ["craft_business", "industrial"] }],
      },
    }

    expect(encodeSearchSpecToQuery(spec)).toContain("category=craft_business%2Cindustrial")
    expect(roundTrip(spec)).toStrictEqual(spec)
  })

  it("uses the opaque form for a bare leaf, so the tree shape survives", () => {
    // The readable parameters carry no bracketing, so decoding always rebuilds
    // an AND branch. Encoding a bare leaf readably would return it wrapped -
    // equivalent in meaning, but a different tree than the user saved.
    const spec: SearchSpec = {
      targetType: "company",
      filters: { op: "eq", key: "core.city", value: "Linz" },
    }

    expect(encodeSearchSpecToQuery(spec)).toContain("q=")
    expect(roundTrip(spec)).toStrictEqual(spec)
  })

  it("round-trips a search with no filters at all", () => {
    // MATCH_ALL is legal: "everything the adapters return".
    const spec: SearchSpec = { targetType: "company", filters: MATCH_ALL }
    expect(roundTrip(spec)).toStrictEqual(spec)
  })

  it("keeps the source list", () => {
    const spec: SearchSpec = {
      targetType: "company",
      filters: { op: "and", children: [{ op: "eq", key: "core.city", value: "Wels" }] },
      sources: ["overpass", "google_places"],
    }

    expect(encodeSearchSpecToQuery(spec)).toContain("sources=overpass%2Cgoogle_places")
    expect(roundTrip(spec)).toStrictEqual(spec)
  })
})

describe("falling back to the opaque form", () => {
  it("uses it for an OR branch", () => {
    // A flat parameter list cannot express OR; pretending otherwise would run
    // an AND search under a URL that says OR.
    const spec: SearchSpec = {
      targetType: "company",
      filters: {
        op: "or",
        children: [
          { op: "eq", key: "core.city", value: "Linz" },
          { op: "eq", key: "core.city", value: "Wels" },
        ],
      },
    }

    expect(encodeSearchSpecToQuery(spec)).toContain("q=")
    expect(roundTrip(spec)).toStrictEqual(spec)
  })

  it("uses it for a negation", () => {
    const spec: SearchSpec = {
      targetType: "company",
      filters: { op: "not", child: { op: "eq", key: "core.city", value: "Linz" } },
    }

    expect(encodeSearchSpecToQuery(spec)).toContain("q=")
    expect(roundTrip(spec)).toStrictEqual(spec)
  })

  it("uses it for a signal filter", () => {
    // Signals have no readable parameter, and inventing one per signal would
    // make the URL schema depend on the provider registry.
    const spec: SearchSpec = {
      targetType: "company",
      filters: { op: "eq", key: "web.presence.has_website", value: false },
    }

    expect(encodeSearchSpecToQuery(spec)).toContain("q=")
    expect(roundTrip(spec)).toStrictEqual(spec)
  })

  it("uses it for an operator the readable form cannot express", () => {
    const spec: SearchSpec = {
      targetType: "company",
      filters: { op: "contains", key: "core.name", value: "Bau" },
    }

    expect(encodeSearchSpecToQuery(spec)).toContain("q=")
    expect(roundTrip(spec)).toStrictEqual(spec)
  })

  it("uses it for a nested AND, rather than flattening it", () => {
    // Flattening would round-trip to a different tree - equivalent in meaning,
    // but not equal, and the user's saved spec would silently change shape.
    const spec: SearchSpec = {
      targetType: "company",
      filters: {
        op: "and",
        children: [
          { op: "eq", key: "core.city", value: "Linz" },
          { op: "and", children: [{ op: "eq", key: "core.country", value: "AT" }] },
        ],
      },
    }

    expect(encodeSearchSpecToQuery(spec)).toContain("q=")
    expect(roundTrip(spec)).toStrictEqual(spec)
  })

  it("uses it when a value contains a comma", () => {
    // "Wels, Stadt" comma-joined would decode as two cities.
    const spec: SearchSpec = {
      targetType: "company",
      filters: { op: "in", key: "core.city", value: ["Wels, Stadt", "Linz"] },
    }

    expect(encodeSearchSpecToQuery(spec)).toContain("q=")
    expect(roundTrip(spec)).toStrictEqual(spec)
  })

  it("can be forced for a spec that would encode readably", () => {
    const query = encodeSearchSpecToQuery(linzCraft, { opaque: true })

    expect(query).toContain("q=")
    expect(query).not.toContain("city=Linz")
    expect(decodeSearchSpec(query).spec).toStrictEqual(linzCraft)
  })

  it("produces a URL-safe blob", () => {
    const spec: SearchSpec = {
      targetType: "company",
      filters: { op: "contains", key: "core.name", value: "Müller & Söhne ~ GmbH?" },
    }
    const blob = encodeSearchSpec(spec).get("q") ?? ""

    // base64url: no +, / or = to be mangled by a URL parser.
    expect(blob).not.toMatch(/[+/=]/)
    expect(roundTrip(spec)).toStrictEqual(spec)
  })
})

describe("decoding untrusted input", () => {
  it("reports a missing target type rather than guessing one", () => {
    const result = decodeSearchSpec("city=Linz")

    expect(result.spec).toBeNull()
    expect(result.errorKey).toBe("missing_target_type")
  })

  it("reports a corrupt blob", () => {
    const result = decodeSearchSpec("target_type=company&q=!!!not-base64!!!")

    expect(result.spec).toBeNull()
    expect(result.errorKey).toBe("invalid_q")
  })

  it("reports a blob that decodes to something that is not a filter", () => {
    const notAFilter = btoa(JSON.stringify({ hello: "world" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")

    expect(decodeSearchSpec(`target_type=company&q=${notAFilter}`).errorKey).toBe("invalid_q")
  })

  it("rejects an unknown target type", () => {
    const result = decodeSearchSpec("target_type=spaceship&city=Linz")

    expect(result.spec).toBeNull()
    expect(result.errorKey).toBe("invalid_spec")
  })

  it("drops a non-numeric limit instead of defaulting it", () => {
    // Guessing 100 when the user wrote "abc" would run a search nobody asked for.
    const result = decodeSearchSpec("target_type=company&city=Linz&limit=abc")

    expect(result.spec?.limit).toBeUndefined()
    expect(result.spec?.filters).toStrictEqual({
      op: "and",
      children: [{ op: "eq", key: "core.city", value: "Linz" }],
    })
  })

  it("drops a negative limit", () => {
    expect(decodeSearchSpec("target_type=company&limit=-5").spec?.limit).toBeUndefined()
  })

  it("ignores parameters it does not know", () => {
    // A URL that picked up tracking parameters must still open the search.
    const result = decodeSearchSpec("target_type=company&city=Linz&utm_source=slack&fbclid=xyz")

    expect(result.spec?.targetType).toBe("company")
    expect(result.spec?.filters).toStrictEqual({
      op: "and",
      children: [{ op: "eq", key: "core.city", value: "Linz" }],
    })
  })

  it("accepts a hand-written URL", () => {
    // The reason the readable form exists: someone types this by hand.
    const result = decodeSearchSpec("target_type=company&category=industrial&city=Wels&limit=50")

    expect(result.spec).toStrictEqual({
      targetType: "company",
      filters: {
        op: "and",
        children: [
          { op: "eq", key: "core.category", value: "industrial" },
          { op: "eq", key: "core.city", value: "Wels" },
        ],
      },
      limit: 50,
    })
  })

  it("takes a URLSearchParams as readily as a string", () => {
    const params = new URLSearchParams({ target_type: "company", city: "Linz" })
    expect(decodeSearchSpec(params).spec?.targetType).toBe("company")
  })
})

describe("the round trip holds for generated trees", () => {
  /**
   * Hand-picked examples only prove the cases I thought of.
   *
   * A deterministic generator covers the combinations I did not: it was this
   * that would have caught the bare-leaf bug, where a single leaf encoded
   * readably and came back wrapped in an AND.
   */
  function makeTree(seed: number, depth: number): FilterNode {
    const pick = (n: number): number => (seed * 9301 + 49297 + depth * 233) % n

    if (depth <= 0) {
      const leaves: FilterNode[] = [
        { op: "eq", key: "core.city", value: "Linz" },
        { op: "in", key: "core.category", value: ["craft_business", "industrial"] },
        { op: "contains", key: "core.name", value: "Bau" },
        { op: "eq", key: "web.presence.has_website", value: false },
        { op: "within", key: "core.geo", value: { bbox: [48, 13, 49, 15] } },
        { op: "exists", key: "legal.impressum.email", value: true },
      ]
      return leaves[pick(leaves.length)] ?? leaves[0]!
    }

    switch (pick(3)) {
      case 0:
        return { op: "and", children: [makeTree(seed + 1, depth - 1), makeTree(seed + 2, 0)] }
      case 1:
        return { op: "or", children: [makeTree(seed + 3, depth - 1), makeTree(seed + 4, 0)] }
      default:
        return { op: "not", child: makeTree(seed + 5, depth - 1) }
    }
  }

  it("survives 200 generated specs unchanged", () => {
    const targetTypes = ["local_business", "company", "person", "list"] as const
    const failures: SearchSpec[] = []

    for (let seed = 0; seed < 200; seed++) {
      const spec: SearchSpec = {
        targetType: targetTypes[seed % targetTypes.length]!,
        filters: makeTree(seed, seed % 4),
        ...(seed % 3 === 0 ? { limit: seed + 1 } : {}),
        ...(seed % 5 === 0 ? { sources: ["overpass"] } : {}),
      }

      const decoded = decodeSearchSpec(encodeSearchSpec(spec)).spec
      if (JSON.stringify(decoded) !== JSON.stringify(spec)) failures.push(spec)
    }

    expect(failures).toStrictEqual([])
  })

  it("survives the same specs when the opaque form is forced", () => {
    const failures: SearchSpec[] = []

    for (let seed = 0; seed < 200; seed++) {
      const spec: SearchSpec = {
        targetType: "company",
        filters: makeTree(seed, seed % 4),
        ...(seed % 2 === 0 ? { limit: seed + 1 } : {}),
      }

      const decoded = decodeSearchSpec(encodeSearchSpec(spec, { opaque: true })).spec
      if (JSON.stringify(decoded) !== JSON.stringify(spec)) failures.push(spec)
    }

    expect(failures).toStrictEqual([])
  })
})
