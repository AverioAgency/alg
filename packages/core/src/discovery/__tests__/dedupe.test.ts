import { describe, expect, it } from "vitest"
import {
  DEFAULT_TRIGRAM_THRESHOLD,
  dedupeBatch,
  findDuplicate,
  toDedupeCandidate,
  trigramSimilarity,
  trigrams,
  type DedupeCandidate,
} from "../dedupe.js"

const base: DedupeCandidate = {
  id: "existing-1",
  sourceId: "google_places",
  externalId: "ChIJxyz",
  domain: "muster-produktion.at",
  phone: "+43732123456",
  nameNormalized: "muster produktion",
  postalCode: "4600",
}

describe("trigramSimilarity", () => {
  it("matches the value Postgres pg_trgm documents", () => {
    // The in-memory cascade and the SQL-side index must agree, or the same pair
    // would merge in one path and not the other.
    expect(trigramSimilarity("word", "two words")).toBeCloseTo(0.363636, 5)
  })

  it("pads words exactly like show_trgm", () => {
    expect([...trigrams("word")]).toStrictEqual(["  w", " wo", "wor", "ord", "rd "])
  })

  it("returns 1 for identical strings", () => {
    expect(trigramSimilarity("muster produktion", "muster produktion")).toBe(1)
  })

  it("scores a trailing plural at or above the threshold", () => {
    // Lands exactly on 0.85, which is why the cascade compares with >= and not >.
    expect(trigramSimilarity("muster produktion", "muster produktions")).toBeGreaterThanOrEqual(
      DEFAULT_TRIGRAM_THRESHOLD
    )
  })

  it("scores genuinely different names below the threshold", () => {
    expect(trigramSimilarity("muster produktion", "beispiel handel")).toBeLessThan(0.2)
  })

  it("handles empty input without dividing by zero", () => {
    expect(trigramSimilarity("", "")).toBe(1)
    expect(trigramSimilarity("muster", "")).toBe(0)
  })
})

describe("findDuplicate - stage order", () => {
  it("matches on source id first", () => {
    const match = findDuplicate({ id: "new", sourceId: "google_places", externalId: "ChIJxyz" }, [
      base,
    ])
    expect(match).toStrictEqual({ candidateId: "existing-1", stage: "source_id", confidence: 1 })
  })

  it("does not match a different source with the same external id", () => {
    // Place ids and OSM ids live in separate namespaces; colliding numbers happen.
    const match = findDuplicate({ id: "new", sourceId: "overpass", externalId: "ChIJxyz" }, [base])
    expect(match).toBeNull()
  })

  it("falls through to domain when the source id is absent", () => {
    const match = findDuplicate({ id: "new", domain: "muster-produktion.at" }, [base])
    expect(match?.stage).toBe("domain")
  })

  it("falls through to phone when domain is absent", () => {
    const match = findDuplicate({ id: "new", phone: "+43732123456" }, [base])
    expect(match?.stage).toBe("phone")
  })

  it("falls through to fuzzy name last", () => {
    const match = findDuplicate(
      { id: "new", nameNormalized: "muster produktions", postalCode: "4600" },
      [base]
    )
    expect(match?.stage).toBe("fuzzy_name")
    expect(match?.confidence).toBeGreaterThanOrEqual(DEFAULT_TRIGRAM_THRESHOLD)
  })

  it("returns null for a genuinely new entity", () => {
    const match = findDuplicate(
      {
        id: "new",
        domain: "anderes-unternehmen.at",
        phone: "+4319999999",
        nameNormalized: "anderes unternehmen",
        postalCode: "1010",
      },
      [base]
    )
    expect(match).toBeNull()
  })
})

describe("findDuplicate - the postcode guard on fuzzy matching", () => {
  it("refuses to merge identical names in different postcodes", () => {
    // Austria has a Gasthaus Zur Post in nearly every village. Without this guard
    // the cascade would collapse them into one company.
    const linz: DedupeCandidate = {
      id: "linz",
      nameNormalized: "gasthaus zur post",
      postalCode: "4020",
    }
    const wels: DedupeCandidate = {
      id: "wels",
      nameNormalized: "gasthaus zur post",
      postalCode: "4600",
    }

    expect(findDuplicate(wels, [linz])).toBeNull()
  })

  it("merges identical names within the same postcode", () => {
    const a: DedupeCandidate = { id: "a", nameNormalized: "gasthaus zur post", postalCode: "4020" }
    const b: DedupeCandidate = { id: "b", nameNormalized: "gasthaus zur post", postalCode: "4020" }

    expect(findDuplicate(b, [a])?.stage).toBe("fuzzy_name")
  })

  it("does not fuzzy match when a postcode is missing on either side", () => {
    const withCode: DedupeCandidate = { id: "a", nameNormalized: "muster bau", postalCode: "4020" }
    const without: DedupeCandidate = { id: "b", nameNormalized: "muster bau", postalCode: null }

    expect(findDuplicate(without, [withCode])).toBeNull()
    expect(findDuplicate(withCode, [without])).toBeNull()
  })

  it("respects a custom threshold", () => {
    const existing: DedupeCandidate = {
      id: "a",
      nameNormalized: "muster bau",
      postalCode: "4020",
    }
    const incoming: DedupeCandidate = {
      id: "b",
      nameNormalized: "muster bau gmbh handel",
      postalCode: "4020",
    }

    expect(findDuplicate(incoming, [existing])).toBeNull()
    expect(findDuplicate(incoming, [existing], { trigramThreshold: 0.4 })?.stage).toBe("fuzzy_name")
  })

  it("picks the best fuzzy match, not merely the first", () => {
    const candidates: DedupeCandidate[] = [
      { id: "loose", nameNormalized: "muster produktion handel", postalCode: "4600" },
      { id: "tight", nameNormalized: "muster produktions", postalCode: "4600" },
    ]

    const match = findDuplicate(
      { id: "new", nameNormalized: "muster produktion", postalCode: "4600" },
      candidates,
      { trigramThreshold: 0.5 }
    )

    expect(match?.candidateId).toBe("tight")
  })
})

describe("dedupeBatch", () => {
  it("collapses duplicates that arrive from different adapters", () => {
    const entities: DedupeCandidate[] = [
      { id: "1", sourceId: "overpass", externalId: "node/1", domain: "muster.at" },
      { id: "2", sourceId: "google_places", externalId: "ChIJabc", domain: "muster.at" },
      { id: "3", sourceId: "overpass", externalId: "node/2", domain: "anderes.at" },
    ]

    const { unique, duplicates } = dedupeBatch(entities)

    expect(unique.map((e) => e.id)).toStrictEqual(["1", "3"])
    expect(duplicates).toHaveLength(1)
    expect(duplicates[0]?.match.stage).toBe("domain")
  })

  it("keeps entities that share nothing", () => {
    const entities: DedupeCandidate[] = [
      { id: "1", domain: "a.at" },
      { id: "2", domain: "b.at" },
      { id: "3", domain: "c.at" },
    ]

    expect(dedupeBatch(entities).unique).toHaveLength(3)
  })

  it("handles an empty batch", () => {
    expect(dedupeBatch([]).unique).toStrictEqual([])
  })

  it("does not merge entities that only share a null field", () => {
    // Two companies without a website must not both match on domain === null.
    const entities: DedupeCandidate[] = [
      { id: "1", domain: null, phone: null, nameNormalized: "erste firma", postalCode: null },
      { id: "2", domain: null, phone: null, nameNormalized: "zweite firma", postalCode: null },
    ]

    expect(dedupeBatch(entities).unique).toHaveLength(2)
  })
})

describe("toDedupeCandidate", () => {
  it("derives the normalized name when it is not supplied", () => {
    const candidate = toDedupeCandidate({ id: "x", name: "Muster Produktion GmbH" })
    expect(candidate.nameNormalized).toBe("muster produktion")
  })

  it("prefers an explicitly supplied normalized name", () => {
    const candidate = toDedupeCandidate({
      id: "x",
      name: "Muster Produktion GmbH",
      nameNormalized: "vorgegeben",
    })
    expect(candidate.nameNormalized).toBe("vorgegeben")
  })
})
