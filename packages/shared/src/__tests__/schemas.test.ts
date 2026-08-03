import { describe, expect, it } from "vitest"
import {
  FilterNodeSchema,
  SearchSpecSchema,
  collectFilterKeys,
  MATCH_ALL,
} from "../types/search.js"
import { RubricSchema } from "../types/scoring.js"
import { decodeCursor, encodeCursor } from "../types/pagination.js"
import { hasAtLeastRole } from "../types/auth.js"

describe("FilterNode", () => {
  it("accepts a nested and/or/not tree", () => {
    const node = {
      op: "and",
      children: [
        { op: "eq", key: "core.address.region", value: "Oberösterreich" },
        {
          op: "or",
          children: [
            { op: "gte", key: "core.employees", value: 20 },
            { op: "not", child: { op: "exists", key: "web.presence.has_website", value: null } },
          ],
        },
      ],
    }

    expect(FilterNodeSchema.safeParse(node).success).toBe(true)
  })

  it("accepts MATCH_ALL as the no-filter identity", () => {
    expect(FilterNodeSchema.safeParse(MATCH_ALL).success).toBe(true)
  })

  it("rejects an unknown operator", () => {
    expect(FilterNodeSchema.safeParse({ op: "regex", key: "x", value: "y" }).success).toBe(false)
  })

  it("rejects a leaf without a key", () => {
    expect(FilterNodeSchema.safeParse({ op: "eq", value: 1 }).success).toBe(false)
  })
})

describe("collectFilterKeys", () => {
  it("walks the whole tree so the planner sees every referenced signal", () => {
    const keys = collectFilterKeys({
      op: "and",
      children: [
        { op: "eq", key: "core.city", value: "Linz" },
        {
          op: "or",
          children: [
            { op: "eq", key: "web.quality.lighthouse_performance", value: 50 },
            { op: "not", child: { op: "exists", key: "gmb.rating", value: null } },
          ],
        },
      ],
    })

    expect(keys.sort()).toStrictEqual([
      "core.city",
      "gmb.rating",
      "web.quality.lighthouse_performance",
    ])
  })

  it("returns nothing for an empty tree - the planner then runs no providers", () => {
    expect(collectFilterKeys(MATCH_ALL)).toStrictEqual([])
  })
})

describe("SearchSpec", () => {
  it("accepts a spec with no sources so the planner may choose", () => {
    const parsed = SearchSpecSchema.safeParse({
      targetType: "local_business",
      filters: { op: "eq", key: "core.category", value: "restaurant" },
    })

    expect(parsed.success).toBe(true)
  })

  it("rejects an unknown target type", () => {
    expect(
      SearchSpecSchema.safeParse({ targetType: "spaceship", filters: MATCH_ALL }).success
    ).toBe(false)
  })
})

describe("Rubric", () => {
  it("accepts a market-research rubric with every weight at zero", () => {
    // This shape has to stay legal: it is how a user searches without ranking.
    const parsed = RubricSchema.safeParse({
      criteria: [
        {
          label: "Hat Website",
          signal: "web.presence.has_website",
          condition: { op: "eq", value: true },
          weight: 0,
          hard: false,
        },
      ],
      threshold: 0,
    })

    expect(parsed.success).toBe(true)
  })

  it("accepts negative weights and hard exclusions", () => {
    const parsed = RubricSchema.safeParse({
      criteria: [
        {
          label: "Bereits Kunde",
          signal: "crm.is_customer",
          condition: { op: "eq", value: true },
          weight: -100,
          hard: true,
        },
      ],
      threshold: 10,
    })

    expect(parsed.success).toBe(true)
  })

  it("rejects a weight outside the documented range", () => {
    const parsed = RubricSchema.safeParse({
      criteria: [
        {
          label: "Zu schwer",
          signal: "x",
          condition: { op: "eq", value: 1 },
          weight: 500,
          hard: false,
        },
      ],
      threshold: 0,
    })

    expect(parsed.success).toBe(false)
  })
})

describe("cursor pagination", () => {
  it("round-trips a keyset cursor", () => {
    const cursor = encodeCursor({ createdAt: "2026-03-09T12:00:00Z", id: "abc" })
    expect(decodeCursor(cursor)).toStrictEqual({ createdAt: "2026-03-09T12:00:00Z", id: "abc" })
  })

  it("returns null for a cursor that is not decodable", () => {
    expect(decodeCursor("!!!not-base64!!!")).toBeNull()
    expect(decodeCursor(encodeCursor({}) + "garbage")).toBeNull()
  })
})

describe("role hierarchy", () => {
  it("treats higher roles as satisfying lower requirements", () => {
    expect(hasAtLeastRole("owner", "member")).toBe(true)
    expect(hasAtLeastRole("admin", "member")).toBe(true)
    expect(hasAtLeastRole("viewer", "member")).toBe(false)
    expect(hasAtLeastRole("member", "owner")).toBe(false)
  })
})
