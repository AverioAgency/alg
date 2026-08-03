import { describe, expect, it, vi } from "vitest"
import {
  type Rubric,
  type SearchSpec,
  type SignalBundle,
  type SignalProvider,
  type TargetType,
} from "@alg/shared"
import { CircularDependencyError, DuplicateSignalError, SignalRegistry } from "../registry.js"
import { estimateSignalCost, planSignals, toStages } from "../planner.js"

/**
 * The acceptance criterion for M2 lives in this file: a search that references no
 * web.* signal must not produce a single crawl job. Everything else here exists
 * to make that property hold under composition - dependencies, target types,
 * zero-weight criteria.
 */

function provider(
  id: string,
  keys: string[],
  options: {
    dependsOn?: string[]
    cost?: number
    appliesTo?: TargetType[]
    run?: () => Promise<SignalBundle>
  } = {}
): SignalProvider {
  return {
    id,
    version: "1.0.0",
    provides: keys.map((key) => ({
      key,
      type: "boolean" as const,
      operators: ["eq" as const],
      labelKey: `signal.${key}`,
    })),
    dependsOn: options.dependsOn ?? [],
    appliesTo: options.appliesTo ?? ["local_business", "company"],
    cost: { unit: "per_entity", amount: options.cost ?? 0, currency: "EUR" },
    ttlDays: 30,
    run:
      options.run ??
      (async () => ({
        values: {},
        provenance: {
          providerId: id,
          providerVersion: "1.0.0",
          fetchedAt: new Date().toISOString(),
        },
      })),
  }
}

/** Mirrors the real registry: cheap HTTP providers plus an expensive crawl. */
function realisticRegistry(): {
  registry: SignalRegistry
  crawlRun: ReturnType<typeof vi.fn>
} {
  const crawlRun = vi.fn(async () => ({
    values: { "web.quality.score": 50 },
    provenance: {
      providerId: "web.quality",
      providerVersion: "1.0.0",
      fetchedAt: new Date().toISOString(),
    },
  }))

  const registry = new SignalRegistry()
    .register(provider("web.presence", ["web.presence.has_website", "web.presence.reachable"]))
    .register(
      provider("legal.impressum", ["legal.impressum.email", "legal.impressum.found"], {
        dependsOn: ["web.presence"],
        cost: 0.001,
      })
    )
    .register(
      provider("web.techstack", ["web.techstack.cms", "web.techstack.shop"], {
        dependsOn: ["web.presence"],
        cost: 0.002,
      })
    )
    .register(
      provider("web.quality", ["web.quality.score"], {
        dependsOn: ["web.presence"],
        cost: 0.05,
        run: crawlRun,
      })
    )
    .register(provider("gmb", ["gmb.rating", "gmb.review_count"], { cost: 0.01 }))

  return { registry, crawlRun }
}

const geoSpec: SearchSpec = {
  targetType: "local_business",
  filters: {
    op: "and",
    children: [
      { op: "eq", key: "core.category", value: "restaurant" },
      { op: "within", key: "core.geo", value: { bbox: [48, 14, 49, 15] } },
    ],
  },
}

describe("M2 acceptance: nothing runs unless something references it", () => {
  it("a search without web.* references produces no provider at all", () => {
    // The market-research case: find restaurants, rank nothing, enrich nothing.
    const { registry, crawlRun } = realisticRegistry()

    const plan = planSignals({ spec: geoSpec }, registry)

    expect(plan.order).toStrictEqual([])
    expect(plan.empty).toBe(true)
    expect(plan.estimatedCostPerEntity).toBe(0)
    expect(crawlRun).not.toHaveBeenCalled()
  })

  it("core.* keys never pull in a provider - discovery already supplied them", () => {
    const { registry } = realisticRegistry()

    const plan = planSignals({ spec: geoSpec }, registry)

    expect(plan.coreKeys).toContain("core.category")
    expect(plan.coreKeys).toContain("core.geo")
    expect(plan.order).toStrictEqual([])
  })

  it("a rubric with every weight at zero still resolves nothing extra", () => {
    // Three example rubrics ship with M3; the market-research one has all
    // weights at zero and must stay free.
    const { registry, crawlRun } = realisticRegistry()
    const rubric: Rubric = {
      criteria: [],
      threshold: 0,
    }

    const plan = planSignals({ spec: geoSpec, rubric }, registry)

    expect(plan.order).toStrictEqual([])
    expect(crawlRun).not.toHaveBeenCalled()
  })

  it("referencing web.quality is what starts the expensive provider", () => {
    const { registry } = realisticRegistry()

    const plan = planSignals(
      {
        spec: {
          ...geoSpec,
          filters: { op: "lt", key: "web.quality.score", value: 60 },
        },
      },
      registry
    )

    expect(plan.order.map((p) => p.id)).toStrictEqual(["web.presence", "web.quality"])
    // web.presence came along as a dependency, not because it was asked for.
    expect(plan.transitive).toStrictEqual(["web.presence"])
  })

  it("a filter on a cheap signal does not drag in the expensive one", () => {
    const { registry, crawlRun } = realisticRegistry()

    const plan = planSignals(
      {
        spec: { ...geoSpec, filters: { op: "eq", key: "web.presence.has_website", value: false } },
      },
      registry
    )

    expect(plan.order.map((p) => p.id)).toStrictEqual(["web.presence"])
    expect(plan.order.some((p) => p.id === "web.quality")).toBe(false)
    expect(crawlRun).not.toHaveBeenCalled()
  })
})

describe("planSignals - where references come from", () => {
  it("collects from filters", () => {
    const { registry } = realisticRegistry()
    const plan = planSignals(
      { spec: { ...geoSpec, filters: { op: "eq", key: "gmb.rating", value: 4 } } },
      registry
    )

    expect(plan.references.fromFilters).toContain("gmb.rating")
    expect(plan.order.map((p) => p.id)).toStrictEqual(["gmb"])
  })

  it("collects from rubric criteria", () => {
    const { registry } = realisticRegistry()
    const rubric: Rubric = {
      criteria: [
        {
          label: "Keine Website",
          signal: "web.presence.has_website",
          condition: { op: "eq", value: false },
          weight: 40,
          hard: false,
        },
      ],
      threshold: 20,
    }

    const plan = planSignals({ spec: geoSpec, rubric }, registry)

    expect(plan.references.fromRubric).toContain("web.presence.has_website")
    expect(plan.order.map((p) => p.id)).toStrictEqual(["web.presence"])
  })

  it("keeps a zero-weight criterion - the user asked to see that column", () => {
    // Dropping it would silently blank a field they explicitly configured.
    const { registry } = realisticRegistry()
    const rubric: Rubric = {
      criteria: [
        {
          label: "Nur anzeigen",
          signal: "gmb.rating",
          condition: { op: "gte", value: 4 },
          weight: 0,
          hard: false,
        },
      ],
      threshold: 0,
    }

    const plan = planSignals({ spec: geoSpec, rubric }, registry)

    expect(plan.order.map((p) => p.id)).toStrictEqual(["gmb"])
  })

  it("collects from template variables", () => {
    // A message that greets with the Impressum contact needs that signal even
    // when no filter or criterion mentions it.
    const { registry } = realisticRegistry()

    const plan = planSignals(
      { spec: geoSpec, templateVariables: ["legal.impressum.email"] },
      registry
    )

    expect(plan.references.fromTemplates).toContain("legal.impressum.email")
    expect(plan.order.map((p) => p.id)).toStrictEqual(["web.presence", "legal.impressum"])
  })

  it("deduplicates a signal referenced from several places", () => {
    const { registry } = realisticRegistry()
    const rubric: Rubric = {
      criteria: [
        {
          label: "Website",
          signal: "web.presence.has_website",
          condition: { op: "eq", value: true },
          weight: 10,
          hard: false,
        },
      ],
      threshold: 0,
    }

    const plan = planSignals(
      {
        spec: { ...geoSpec, filters: { op: "eq", key: "web.presence.has_website", value: true } },
        rubric,
        templateVariables: ["web.presence.has_website"],
      },
      registry
    )

    expect(plan.order).toHaveLength(1)
  })
})

describe("dependency resolution", () => {
  it("orders dependencies before their dependents", () => {
    const { registry } = realisticRegistry()

    const plan = planSignals(
      {
        spec: { ...geoSpec, filters: { op: "exists", key: "legal.impressum.email", value: true } },
      },
      registry
    )

    const ids = plan.order.map((p) => p.id)
    expect(ids.indexOf("web.presence")).toBeLessThan(ids.indexOf("legal.impressum"))
  })

  it("pulls a shared dependency in only once", () => {
    const { registry } = realisticRegistry()

    const plan = planSignals(
      {
        spec: {
          ...geoSpec,
          filters: {
            op: "and",
            children: [
              { op: "exists", key: "legal.impressum.email", value: true },
              { op: "eq", key: "web.techstack.cms", value: "wordpress" },
            ],
          },
        },
      },
      registry
    )

    expect(plan.order.filter((p) => p.id === "web.presence")).toHaveLength(1)
    expect(plan.order.map((p) => p.id)).toStrictEqual([
      "web.presence",
      "legal.impressum",
      "web.techstack",
    ])
  })

  it("refuses a circular dependency instead of picking an order", () => {
    // Either provider running first gives the other incomplete input, and which
    // one wins would depend on map iteration order.
    const registry = new SignalRegistry()
      .register(provider("a", ["a.x"], { dependsOn: ["b"] }))
      .register(provider("b", ["b.x"], { dependsOn: ["a"] }))

    expect(() => registry.resolve(["a.x"])).toThrow(CircularDependencyError)
  })

  it("reports a dependency on a provider that is not registered", () => {
    const registry = new SignalRegistry().register(
      provider("a", ["a.x"], { dependsOn: ["nowhere"] })
    )

    const plan = registry.resolve(["a.x"])
    expect(plan.unresolved.join(" ")).toContain("nowhere")
  })

  it("produces the same order every time", () => {
    // A wobbling order would make cost estimates wobble with it.
    const { registry } = realisticRegistry()
    const keys = ["web.techstack.cms", "legal.impressum.email", "gmb.rating"]

    const first = registry.resolve(keys).order.map((p) => p.id)
    const second = registry.resolve([...keys].reverse()).order.map((p) => p.id)

    expect(first).toStrictEqual(second)
  })
})

describe("target types", () => {
  it("leaves out a provider that does not apply to the target type", () => {
    const registry = new SignalRegistry().register(
      provider("gmb", ["gmb.rating"], { appliesTo: ["local_business"] })
    )

    const forCompany = registry.resolve(["gmb.rating"], "company")
    expect(forCompany.order).toStrictEqual([])
    expect(forCompany.unresolved).toContain("gmb.rating")

    const forLocal = registry.resolve(["gmb.rating"], "local_business")
    expect(forLocal.order.map((p) => p.id)).toStrictEqual(["gmb"])
  })
})

describe("registry integrity", () => {
  it("refuses two providers claiming the same signal", () => {
    // Which one wins would otherwise depend on registration order.
    const registry = new SignalRegistry().register(provider("a", ["shared.key"]))

    expect(() => registry.register(provider("b", ["shared.key"]))).toThrow(DuplicateSignalError)
  })

  it("refuses a duplicate provider id", () => {
    const registry = new SignalRegistry().register(provider("a", ["a.x"]))
    expect(() => registry.register(provider("a", ["a.y"]))).toThrow(/already registered/)
  })

  it("reports a referenced signal no provider produces", () => {
    const { registry } = realisticRegistry()
    const plan = registry.resolve(["nonexistent.signal"])

    expect(plan.order).toStrictEqual([])
    expect(plan.unresolved).toStrictEqual(["nonexistent.signal"])
  })
})

describe("estimateSignalCost", () => {
  it("breaks the cost down per provider", () => {
    // "12 EUR" is not actionable; "10 of that is web.quality" tells the user
    // which criterion to drop.
    const { registry } = realisticRegistry()
    const plan = planSignals(
      { spec: { ...geoSpec, filters: { op: "lt", key: "web.quality.score", value: 60 } } },
      registry
    )

    const preview = estimateSignalCost(plan, 100)

    expect(preview.totalEur).toBeCloseTo(5, 4)
    expect(preview.perProvider.find((p) => p.providerId === "web.quality")?.totalEur).toBeCloseTo(
      5,
      4
    )
  })

  it("costs nothing when nothing has to run", () => {
    const { registry } = realisticRegistry()
    const preview = estimateSignalCost(planSignals({ spec: geoSpec }, registry), 1000)

    expect(preview.totalEur).toBe(0)
    expect(preview.perProvider).toStrictEqual([])
  })
})

describe("toStages", () => {
  it("groups independent providers so they can run concurrently", () => {
    const { registry } = realisticRegistry()
    const plan = planSignals(
      {
        spec: {
          ...geoSpec,
          filters: {
            op: "and",
            children: [
              { op: "exists", key: "legal.impressum.email", value: true },
              { op: "eq", key: "web.techstack.cms", value: "wordpress" },
              { op: "gte", key: "gmb.rating", value: 4 },
            ],
          },
        },
      },
      registry
    )

    const stages = toStages(plan)

    // gmb has no dependencies, so it shares stage 0 with web.presence.
    expect(stages[0]?.map((p) => p.id).sort()).toStrictEqual(["gmb", "web.presence"])
    expect(stages[1]?.map((p) => p.id).sort()).toStrictEqual(["legal.impressum", "web.techstack"])
  })
})
