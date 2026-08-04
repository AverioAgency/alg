import { describe, expect, it } from "vitest"
import {
  type CostEstimate,
  type DiscoveryAdapter,
  type RawEntity,
  type SearchSpec,
  type TargetType,
} from "@alg/shared"
import { type Database } from "@alg/db"
import { DiscoveryRegistry } from "../registry.js"
import { runDiscovery } from "../run.js"
import { normalizeEntity } from "../persist.js"

/**
 * Orchestration is tested against stub adapters and a stub database. The point
 * is the control flow - which adapters run, what happens when one fails, whether
 * post-filters are applied - not SQL, which the integration suite covers.
 */

function entity(name: string, overrides: Partial<RawEntity> = {}): RawEntity {
  return {
    source: "stub",
    targetType: "local_business",
    name,
    ...overrides,
  }
}

class StubAdapter implements DiscoveryAdapter {
  readonly targetTypes: TargetType[] = ["local_business"]
  calls = 0

  constructor(
    readonly id: string,
    private readonly entities: RawEntity[],
    readonly supports: string[] = [],
    private readonly costEur = 0,
    private readonly failWith?: string
  ) {}

  estimateCost(): CostEstimate {
    return {
      estimatedEntities: this.entities.length,
      estimatedCostEur: this.costEur,
      degraded: false,
    }
  }

  async search(): Promise<{ entities: RawEntity[]; cursor?: string }> {
    this.calls++
    if (this.failWith) throw new Error(this.failWith)
    return { entities: this.entities }
  }
}

/** Records inserts so the orchestration can be observed without a real database. */
function stubDb(): { db: Database; inserted: string[] } {
  const inserted: string[] = []

  const chain = {
    values: (row: Record<string, unknown>) => {
      if (typeof row.name === "string") inserted.push(row.name)
      return {
        returning: () => Promise.resolve([{ id: `id-${inserted.length}` }]),
        onConflictDoNothing: () => Promise.resolve(),
        then: (resolve: (v: unknown) => void) => resolve(undefined),
      }
    },
  }

  const api = {
    insert: () => chain,
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([]) }),
      }),
    }),
  }

  return { db: api as unknown as Database, inserted }
}

const geoSpec: SearchSpec = {
  targetType: "local_business",
  filters: { op: "within", key: "core.geo", value: { bbox: [48, 14, 49, 15] } },
  limit: 100,
}

describe("runDiscovery", () => {
  it("returns an empty result when no adapter serves the target type", async () => {
    const registry = new DiscoveryRegistry()
    const { db } = stubDb()

    const result = await runDiscovery({
      spec: { targetType: "person", filters: { op: "and", children: [] } },
      workspaceId: "11111111-1111-1111-1111-111111111111",
      runId: "22222222-2222-2222-2222-222222222222",
      registry,
      db,
    })

    expect(result.found).toBe(0)
    expect(result.adapters).toStrictEqual([])
  })

  it("collects from every eligible adapter", async () => {
    const registry = new DiscoveryRegistry()
      .register(new StubAdapter("a", [entity("Firma A")], ["core.geo"]))
      .register(new StubAdapter("b", [entity("Firma B")], ["core.geo"]))
    const { db, inserted } = stubDb()

    const result = await runDiscovery({
      spec: geoSpec,
      workspaceId: "11111111-1111-1111-1111-111111111111",
      runId: "22222222-2222-2222-2222-222222222222",
      registry,
      db,
    })

    expect(result.found).toBe(2)
    expect(inserted).toStrictEqual(["Firma A", "Firma B"])
  })

  it("drops a hit outside the searched area, even from an adapter that claims geo support", async () => {
    /**
     * Genau der Fall aus der Produktion: Places nennt core.geo als
     * unterstuetzt, laesst den Ortsbezug bei einem zu grossen Gebiet aber weg
     * (Bias-Radius max. 50 km). Die Registry hielt den Filter fuer erledigt,
     * niemand prueft nach - und in einer Oesterreich-Suche standen Treffer aus
     * Pafos und Neubrandenburg.
     */
    const registry = new DiscoveryRegistry().register(
      new StubAdapter(
        "places",
        [
          entity("Linzer Baufirma", { geo: { lat: 48.3, lon: 14.28 } }),
          entity("Grill in Pafos", { geo: { lat: 34.77, lon: 32.42 } }),
        ],
        // Behauptet, geografisch filtern zu koennen.
        ["core.geo"]
      )
    )
    const { db, inserted } = stubDb()

    const result = await runDiscovery({
      spec: geoSpec,
      workspaceId: "11111111-1111-1111-1111-111111111111",
      runId: "22222222-2222-2222-2222-222222222222",
      registry,
      db,
    })

    expect(result.found).toBe(1)
    expect(inserted).toStrictEqual(["Linzer Baufirma"])
  })

  it("keeps a hit whose coordinates the source did not supply", async () => {
    // Places fuehrt `location` als optional. Eine Linzer Firma ohne Koordinate
    // ist nicht widerlegt, nur unbelegt - sie zu verwerfen hiesse,
    // unvollstaendige Daten wie eine Absage zu behandeln.
    const registry = new DiscoveryRegistry().register(
      new StubAdapter("places", [entity("Firma ohne Koordinate")], ["core.geo"])
    )
    const { db } = stubDb()

    const result = await runDiscovery({
      spec: geoSpec,
      workspaceId: "11111111-1111-1111-1111-111111111111",
      runId: "22222222-2222-2222-2222-222222222222",
      registry,
      db,
    })

    expect(result.found).toBe(1)
  })

  it("uses the country when there is no coordinate", async () => {
    // Kein Punkt, aber ein Land: das reicht, um Zypern von Oesterreich zu
    // unterscheiden.
    const registry = new DiscoveryRegistry().register(
      new StubAdapter(
        "places",
        [
          entity("Wiener Betrieb", { address: { country: "AT" } }),
          entity("Zyprischer Betrieb", { address: { country: "CY" } }),
        ],
        ["core.geo"]
      )
    )
    const { db, inserted } = stubDb()

    await runDiscovery({
      spec: geoSpec,
      workspaceId: "11111111-1111-1111-1111-111111111111",
      runId: "22222222-2222-2222-2222-222222222222",
      registry,
      db,
    })

    expect(inserted).toStrictEqual(["Wiener Betrieb"])
  })

  it("keeps the results of other adapters when one fails", async () => {
    // A single flaky source must not discard a whole run.
    const registry = new DiscoveryRegistry()
      .register(new StubAdapter("good", [entity("Firma A")], ["core.geo"]))
      .register(new StubAdapter("bad", [], ["core.geo"], 0, "upstream exploded"))
    const { db } = stubDb()

    const result = await runDiscovery({
      spec: geoSpec,
      workspaceId: "11111111-1111-1111-1111-111111111111",
      runId: "22222222-2222-2222-2222-222222222222",
      registry,
      db,
    })

    expect(result.found).toBe(1)
    expect(result.adapters.find((a) => a.adapterId === "bad")?.error).toContain("upstream exploded")
  })

  it("applies filters the adapter could not push down", async () => {
    // The adapter declares no support for core.city, so the orchestrator has to
    // drop the non-matching row itself.
    const registry = new DiscoveryRegistry().register(
      new StubAdapter(
        "a",
        [
          entity("In Linz", { address: { city: "Linz" } }),
          entity("In Wels", { address: { city: "Wels" } }),
        ],
        []
      )
    )
    const { db, inserted } = stubDb()

    const result = await runDiscovery({
      spec: {
        targetType: "local_business",
        filters: { op: "eq", key: "core.city", value: "Linz" },
      },
      workspaceId: "11111111-1111-1111-1111-111111111111",
      runId: "22222222-2222-2222-2222-222222222222",
      registry,
      db,
    })

    expect(result.found).toBe(1)
    expect(inserted).toStrictEqual(["In Linz"])
  })

  it("deduplicates within the batch before writing", async () => {
    // Overpass and Places routinely return the same restaurant.
    const registry = new DiscoveryRegistry()
      .register(
        new StubAdapter("a", [entity("Muster", { website: "https://muster.at" })], ["core.geo"])
      )
      .register(
        new StubAdapter(
          "b",
          [entity("Muster GmbH", { website: "https://www.muster.at/" })],
          ["core.geo"]
        )
      )
    const { db, inserted } = stubDb()

    const result = await runDiscovery({
      spec: geoSpec,
      workspaceId: "11111111-1111-1111-1111-111111111111",
      runId: "22222222-2222-2222-2222-222222222222",
      registry,
      db,
    })

    expect(result.found).toBe(2)
    expect(inserted).toHaveLength(1)
    expect(result.duplicates).toBe(1)
  })

  it("skips an adapter that would exceed the budget", async () => {
    const cheap = new StubAdapter("cheap", [entity("A")], ["core.geo"], 0.5)
    const expensive = new StubAdapter("expensive", [entity("B")], ["core.geo"], 10)
    const registry = new DiscoveryRegistry().register(cheap).register(expensive)
    const { db } = stubDb()

    const result = await runDiscovery({
      spec: geoSpec,
      workspaceId: "11111111-1111-1111-1111-111111111111",
      runId: "22222222-2222-2222-2222-222222222222",
      registry,
      db,
      budgetEur: 1,
    })

    // Not started at all, rather than aborted midway: a partial page from a paid
    // API costs the same as a whole one.
    expect(expensive.calls).toBe(0)
    expect(result.adapters.find((a) => a.adapterId === "expensive")?.error).toBe("budget_exceeded")
  })

  it("reports progress for each adapter", async () => {
    const registry = new DiscoveryRegistry().register(
      new StubAdapter("a", [entity("Firma")], ["core.geo"])
    )
    const { db } = stubDb()
    const events: string[] = []

    await runDiscovery({
      spec: geoSpec,
      workspaceId: "11111111-1111-1111-1111-111111111111",
      runId: "22222222-2222-2222-2222-222222222222",
      registry,
      db,
      onProgress: (event) => {
        events.push(event.type)
      },
    })

    expect(events).toContain("adapter_started")
    expect(events).toContain("adapter_finished")
    expect(events).toContain("progress")
  })

  it("stops when the abort signal fires", async () => {
    const adapter = new StubAdapter("a", [entity("Firma")], ["core.geo"])
    const registry = new DiscoveryRegistry().register(adapter)
    const { db } = stubDb()
    const controller = new AbortController()
    controller.abort()

    const result = await runDiscovery({
      spec: geoSpec,
      workspaceId: "11111111-1111-1111-1111-111111111111",
      runId: "22222222-2222-2222-2222-222222222222",
      registry,
      db,
      signal: controller.signal,
    })

    expect(adapter.calls).toBe(0)
    expect(result.found).toBe(0)
  })

  it("respects the limit across adapters", async () => {
    const registry = new DiscoveryRegistry()
      .register(new StubAdapter("a", [entity("A1"), entity("A2"), entity("A3")], ["core.geo"]))
      .register(new StubAdapter("b", [entity("B1")], ["core.geo"]))
    const { db } = stubDb()

    const result = await runDiscovery({
      spec: { ...geoSpec, limit: 2 },
      workspaceId: "11111111-1111-1111-1111-111111111111",
      runId: "22222222-2222-2222-2222-222222222222",
      registry,
      db,
    })

    expect(result.found).toBeLessThanOrEqual(2)
  })
})

describe("normalizeEntity", () => {
  it("normalizes every field the dedupe cascade compares", () => {
    const normalized = normalizeEntity({
      source: "overpass",
      sourceId: "node/1",
      targetType: "local_business",
      name: "Muster Produktion GmbH",
      website: "https://www.muster-produktion.at/kontakt",
      phone: "0732 123456",
      email: "  Office@Muster.AT ",
      address: { postal_code: " 4600 ", city: "Wels", country: "at" },
    })

    expect(normalized).toMatchObject({
      nameNormalized: "muster produktion",
      domain: "muster-produktion.at",
      phone: "+43732123456",
      email: "office@muster.at",
      postalCode: "4600",
      countryCode: "AT",
    })
  })

  it("uses the country to interpret a national phone number", () => {
    const german = normalizeEntity({
      source: "csv",
      targetType: "company",
      name: "Muster",
      phone: "089 1234567",
      address: { country: "DE" },
    })

    expect(german?.phone).toBe("+49891234567")
  })

  it("returns null without a usable name", () => {
    expect(normalizeEntity({ source: "csv", targetType: "company", name: "   " })).toBeNull()
  })
})
