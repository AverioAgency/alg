import { describe, expect, it } from "vitest"
import { type Database } from "@alg/db"
import { type SignalBundle, type SignalProvider } from "@alg/shared"
import { enrichCompanies } from "../enrich.js"
import { planSignals } from "../planner.js"
import { SignalRegistry } from "../registry.js"

/**
 * The caching behaviour is what keeps ALG from crawling the same Impressum every
 * time a rubric changes. These tests pin it against a stub database, so the
 * property is checked without needing Postgres.
 */

const WORKSPACE = "11111111-1111-1111-1111-111111111111"
const COMPANY = "22222222-2222-2222-2222-222222222222"

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

interface StoredRow {
  companyId: string
  providerId: string
  providerVersion: string
  values: Record<string, unknown>
  expiresAt: Date | null
  error: string | null
}

/**
 * Stub database that serves companies and enrichments and records writes.
 * Distinguishes the two tables by which one the query selected from.
 */
/** Drizzle keeps the table name in a symbol, not on a plain property. */
function tableName(table: unknown): string {
  if (typeof table !== "object" || table === null) return ""
  const symbol = Object.getOwnPropertySymbols(table).find(
    (s) => String(s) === "Symbol(drizzle:Name)"
  )
  return symbol ? String((table as Record<symbol, unknown>)[symbol]) : ""
}

function stubDb(existing: StoredRow[] = []): { db: Database; written: StoredRow[] } {
  const written: StoredRow[] = []

  const api = {
    select: () => ({
      from: (table: unknown) => {
        const isEnrichments = tableName(table).includes("enrichment")
        const chain = {
          where: () => chain,
          limit: () =>
            Promise.resolve(
              isEnrichments
                ? existing
                : [
                    {
                      id: COMPANY,
                      workspaceId: WORKSPACE,
                      targetType: "local_business",
                      name: "Muster GmbH",
                      domain: "muster.at",
                      website: "https://muster.at",
                      phone: null,
                      email: null,
                      street: null,
                      houseNumber: null,
                      postalCode: "4020",
                      city: "Linz",
                      region: null,
                      countryCode: "AT",
                      lat: null,
                      lon: null,
                    },
                  ]
            ),
          then: (resolve: (v: unknown) => void) => resolve(isEnrichments ? existing : []),
        }
        return chain
      },
    }),
    insert: () => ({
      values: (row: StoredRow) => ({
        onConflictDoUpdate: () => {
          written.push(row)
          return Promise.resolve()
        },
        onConflictDoNothing: () => Promise.resolve(),
        then: (resolve: (v: unknown) => void) => {
          written.push(row)
          resolve(undefined)
        },
      }),
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  }

  return { db: api as unknown as Database, written }
}

function provider(
  id: string,
  values: Record<string, unknown>,
  options: { version?: string; ttlDays?: number; dependsOn?: string[]; fail?: string } = {}
): SignalProvider & { runs: number } {
  const impl = {
    id,
    version: options.version ?? "1.0.0",
    provides: Object.keys(values).map((key) => ({
      key,
      type: "boolean" as const,
      operators: ["eq" as const],
      labelKey: `signal.${key}`,
    })),
    dependsOn: options.dependsOn ?? [],
    appliesTo: ["local_business" as const],
    cost: { unit: "per_entity" as const, amount: 0, currency: "EUR" as const },
    ttlDays: options.ttlDays ?? 30,
    runs: 0,
    async run(): Promise<SignalBundle> {
      impl.runs++
      if (options.fail) throw new Error(options.fail)
      return {
        values,
        provenance: {
          providerId: id,
          providerVersion: options.version ?? "1.0.0",
          fetchedAt: new Date().toISOString(),
        },
      }
    },
  }
  return impl
}

function planFor(registry: SignalRegistry, keys: string[]) {
  return planSignals(
    {
      spec: {
        targetType: "local_business",
        filters: { op: "and", children: keys.map((key) => ({ op: "exists", key, value: true })) },
      },
    },
    registry
  )
}

describe("enrichCompanies caching", () => {
  it("does not refetch a value that is still within its TTL", async () => {
    // Crawling the same Impressum twice in a week costs the target site
    // bandwidth and gains nothing.
    const p = provider("web.presence", { "web.presence.has_website": true })
    const registry = new SignalRegistry().register(p)
    const plan = planFor(registry, ["web.presence.has_website"])

    const tomorrow = new Date(Date.now() + 86_400_000)
    const { db } = stubDb([
      {
        companyId: COMPANY,
        providerId: "web.presence",
        providerVersion: "1.0.0",
        values: { "web.presence.has_website": true },
        expiresAt: tomorrow,
        error: null,
      },
    ])

    const result = await enrichCompanies({
      workspaceId: WORKSPACE,
      companyIds: [COMPANY],
      plan,
      db,
      runId: "run-1",
      logger,
    })

    expect(p.runs).toBe(0)
    expect(result.cacheHits).toBe(1)
    expect(result.providersRun).toBe(0)
  })

  it("refetches once the TTL has passed", async () => {
    const p = provider("web.presence", { "web.presence.has_website": true })
    const registry = new SignalRegistry().register(p)
    const plan = planFor(registry, ["web.presence.has_website"])

    const yesterday = new Date(Date.now() - 86_400_000)
    const { db } = stubDb([
      {
        companyId: COMPANY,
        providerId: "web.presence",
        providerVersion: "1.0.0",
        values: {},
        expiresAt: yesterday,
        error: null,
      },
    ])

    const result = await enrichCompanies({
      workspaceId: WORKSPACE,
      companyIds: [COMPANY],
      plan,
      db,
      runId: "run-1",
      logger,
    })

    expect(p.runs).toBe(1)
    expect(result.cacheHits).toBe(0)
  })

  it("refetches when the provider version changed", async () => {
    // A provider that learned a new CMS signature should re-run even though the
    // stored value has not aged out.
    const p = provider("web.techstack", { "web.techstack.cms": "WordPress" }, { version: "2.0.0" })
    const registry = new SignalRegistry().register(p)
    const plan = planFor(registry, ["web.techstack.cms"])

    const { db } = stubDb([
      {
        companyId: COMPANY,
        providerId: "web.techstack",
        providerVersion: "1.0.0",
        values: { "web.techstack.cms": null },
        expiresAt: new Date(Date.now() + 86_400_000),
        error: null,
      },
    ])

    await enrichCompanies({
      workspaceId: WORKSPACE,
      companyIds: [COMPANY],
      plan,
      db,
      runId: "run-1",
      logger,
    })

    expect(p.runs).toBe(1)
  })

  it("refetches a row that recorded an error", async () => {
    const p = provider("web.presence", { "web.presence.has_website": true })
    const registry = new SignalRegistry().register(p)
    const plan = planFor(registry, ["web.presence.has_website"])

    const { db } = stubDb([
      {
        companyId: COMPANY,
        providerId: "web.presence",
        providerVersion: "1.0.0",
        values: {},
        expiresAt: new Date(Date.now() + 86_400_000),
        error: "timeout",
      },
    ])

    await enrichCompanies({
      workspaceId: WORKSPACE,
      companyIds: [COMPANY],
      plan,
      db,
      runId: "run-1",
      logger,
    })

    expect(p.runs).toBe(1)
  })

  it("force ignores a fresh cache entry", async () => {
    const p = provider("web.presence", { "web.presence.has_website": true })
    const registry = new SignalRegistry().register(p)
    const plan = planFor(registry, ["web.presence.has_website"])

    const { db } = stubDb([
      {
        companyId: COMPANY,
        providerId: "web.presence",
        providerVersion: "1.0.0",
        values: {},
        expiresAt: new Date(Date.now() + 86_400_000),
        error: null,
      },
    ])

    await enrichCompanies({
      workspaceId: WORKSPACE,
      companyIds: [COMPANY],
      plan,
      db,
      runId: "run-1",
      logger,
      force: true,
    })

    expect(p.runs).toBe(1)
  })
})

describe("enrichCompanies execution", () => {
  it("runs nothing when the plan is empty", async () => {
    // The M2 acceptance property, one layer down: an empty plan reaches the
    // database not at all.
    const registry = new SignalRegistry()
    const plan = planFor(registry, [])
    const { db, written } = stubDb()

    const result = await enrichCompanies({
      workspaceId: WORKSPACE,
      companyIds: [COMPANY],
      plan,
      db,
      runId: "run-1",
      logger,
    })

    expect(result.providersRun).toBe(0)
    expect(written).toStrictEqual([])
  })

  it("feeds one provider's output into the next", async () => {
    // legal.impressum has to see whether web.presence found a reachable site,
    // or it would crawl dead domains.
    const seen: Record<string, unknown>[] = []

    const presence = provider("web.presence", { "web.presence.reachable": true })
    const impressum: SignalProvider = {
      id: "legal.impressum",
      version: "1.0.0",
      provides: [
        {
          key: "legal.impressum.found",
          type: "boolean",
          operators: ["eq"],
          labelKey: "x",
        },
      ],
      dependsOn: ["web.presence"],
      appliesTo: ["local_business"],
      cost: { unit: "per_entity", amount: 0, currency: "EUR" },
      ttlDays: 90,
      async run(entity) {
        seen.push({ ...entity.signals })
        return {
          values: { "legal.impressum.found": true },
          provenance: {
            providerId: "legal.impressum",
            providerVersion: "1.0.0",
            fetchedAt: new Date().toISOString(),
          },
        }
      },
    }

    const registry = new SignalRegistry().register(presence).register(impressum)
    const plan = planFor(registry, ["legal.impressum.found"])
    const { db } = stubDb()

    await enrichCompanies({
      workspaceId: WORKSPACE,
      companyIds: [COMPANY],
      plan,
      db,
      runId: "run-1",
      logger,
    })

    expect(seen[0]?.["web.presence.reachable"]).toBe(true)
  })

  it("keeps going when one provider fails", async () => {
    // The failing provider still has to declare what it produces, or the
    // registry cannot resolve the key that selects it.
    const failing = provider(
      "web.presence",
      { "web.presence.has_website": true },
      { fail: "network down" }
    )
    const working = provider("gmb", { "gmb.rating": 4 })

    const registry = new SignalRegistry().register(failing).register(working)
    const plan = planFor(registry, ["web.presence.has_website", "gmb.rating"])
    const { db } = stubDb()

    const result = await enrichCompanies({
      workspaceId: WORKSPACE,
      companyIds: [COMPANY],
      plan,
      db,
      runId: "run-1",
      logger,
    })

    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.reason).toContain("network down")
    expect(working.runs).toBe(1)
    expect(result.companiesDone).toBe(1)
  })

  it("reports progress per company and provider", async () => {
    const p = provider("web.presence", { "web.presence.has_website": true })
    const registry = new SignalRegistry().register(p)
    const plan = planFor(registry, ["web.presence.has_website"])
    const { db } = stubDb()
    const events: string[] = []

    await enrichCompanies({
      workspaceId: WORKSPACE,
      companyIds: [COMPANY],
      plan,
      db,
      runId: "run-1",
      logger,
      onProgress: (event) => {
        events.push(event.type)
      },
    })

    expect(events).toStrictEqual(["company_started", "provider_done", "company_done"])
  })

  it("stops when the abort signal fires", async () => {
    const p = provider("web.presence", { "web.presence.has_website": true })
    const registry = new SignalRegistry().register(p)
    const plan = planFor(registry, ["web.presence.has_website"])
    const { db } = stubDb()

    const controller = new AbortController()
    controller.abort()

    const result = await enrichCompanies({
      workspaceId: WORKSPACE,
      companyIds: [COMPANY],
      plan,
      db,
      runId: "run-1",
      logger,
      signal: controller.signal,
    })

    expect(p.runs).toBe(0)
    expect(result.companiesDone).toBe(0)
  })

  it("stores the value with an expiry derived from the provider's TTL", async () => {
    const p = provider("legal.impressum", { "legal.impressum.found": true }, { ttlDays: 90 })
    const registry = new SignalRegistry().register(p)
    const plan = planFor(registry, ["legal.impressum.found"])
    const { db, written } = stubDb()

    const at = new Date("2026-08-03T12:00:00Z")
    await enrichCompanies({
      workspaceId: WORKSPACE,
      companyIds: [COMPANY],
      plan,
      db,
      runId: "run-1",
      logger,
      now: () => at,
    })

    const stored = written[0]
    expect(stored?.providerId).toBe("legal.impressum")
    const days = (stored!.expiresAt!.getTime() - at.getTime()) / 86_400_000
    expect(Math.round(days)).toBe(90)
  })
})
