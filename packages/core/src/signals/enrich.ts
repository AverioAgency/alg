import { and, eq, inArray, sql } from "drizzle-orm"
import { companies, enrichments, withWorkspace, type Database } from "@alg/db"
import { type Entity, type RunContext, type SignalProvider } from "@alg/shared"
import { type SignalPlan } from "./planner.js"

/**
 * Runs the planned providers over a set of companies.
 *
 * Two properties matter more than throughput:
 *
 *   - A cached value that is still within its TTL is never refetched. Crawling
 *     the same Impressum twice in a week costs the target site bandwidth and
 *     gains nothing.
 *   - Providers run in plan order per company, and each one sees what the
 *     previous ones produced. legal.impressum needs to know whether
 *     web.presence found a reachable site, or it would crawl dead domains.
 */

/**
 * Drizzle types a jsonb column as unknown; the signal map is always an object of
 * key/value pairs because that is the only shape a provider can return.
 */
function toSignalMap(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? // eslint-disable-next-line no-restricted-syntax -- shape verified by the check above
      (value as Record<string, unknown>)
    : {}
}

export interface EnrichOptions {
  workspaceId: string
  companyIds: readonly string[]
  plan: SignalPlan
  db: Database
  runId: string
  logger: RunContext["logger"]
  signal?: AbortSignal
  /** Ignores the cache; used when a provider version changed. */
  force?: boolean
  now?: () => Date
  onProgress?: (event: EnrichProgress) => void | Promise<void>
}

export type EnrichProgress =
  | { type: "company_started"; companyId: string; index: number; total: number }
  | { type: "provider_done"; companyId: string; providerId: string; cached: boolean }
  | { type: "provider_failed"; companyId: string; providerId: string; reason: string }
  | { type: "company_done"; companyId: string; index: number; total: number }

export interface EnrichResult {
  companiesDone: number
  providersRun: number
  cacheHits: number
  failures: { companyId: string; providerId: string; reason: string }[]
}

export async function enrichCompanies(options: EnrichOptions): Promise<EnrichResult> {
  const now = options.now ?? (() => new Date())
  const result: EnrichResult = {
    companiesDone: 0,
    providersRun: 0,
    cacheHits: 0,
    failures: [],
  }

  if (options.plan.order.length === 0 || options.companyIds.length === 0) {
    return result
  }

  const total = options.companyIds.length

  for (const [index, companyId] of options.companyIds.entries()) {
    if (options.signal?.aborted) break

    await options.onProgress?.({ type: "company_started", companyId, index, total })

    const entity = await loadEntity(companyId, options)
    if (!entity) continue

    const cached = await loadCachedSignals(companyId, options, now())
    // Cached values are part of the entity from the start: a provider must not
    // re-derive something a previous run already established.
    entity.signals = { ...cached.values, ...entity.signals }

    for (const provider of options.plan.order) {
      if (options.signal?.aborted) break

      if (!options.force && cached.freshProviders.has(provider.id)) {
        result.cacheHits++
        await options.onProgress?.({
          type: "provider_done",
          companyId,
          providerId: provider.id,
          cached: true,
        })
        continue
      }

      try {
        const bundle = await provider.run(entity, {
          workspaceId: options.workspaceId,
          runId: options.runId,
          signal: options.signal ?? new AbortController().signal,
          logger: options.logger,
        })

        await storeBundle(companyId, provider, bundle, options, now())

        // Feed the result forward so the next provider in the DAG sees it.
        entity.signals = { ...entity.signals, ...bundle.values }
        result.providersRun++

        await options.onProgress?.({
          type: "provider_done",
          companyId,
          providerId: provider.id,
          cached: false,
        })
      } catch (error) {
        // One provider failing must not abandon the rest for this company, nor
        // the remaining companies.
        const reason = error instanceof Error ? error.message : String(error)
        result.failures.push({ companyId, providerId: provider.id, reason })
        options.logger.warn({ companyId, providerId: provider.id, reason }, "provider failed")

        await options.onProgress?.({
          type: "provider_failed",
          companyId,
          providerId: provider.id,
          reason,
        })
      }
    }

    result.companiesDone++
    await options.onProgress?.({ type: "company_done", companyId, index, total })
  }

  return result
}

async function loadEntity(companyId: string, options: EnrichOptions): Promise<Entity | null> {
  const [row] = await withWorkspace(
    { workspaceId: options.workspaceId },
    async ({ tx, scope }) =>
      tx
        .select()
        .from(companies)
        .where(scope(companies, eq(companies.id, companyId)))
        .limit(1),
    options.db
  )

  if (!row) return null

  return {
    id: row.id,
    workspaceId: row.workspaceId,
    targetType: row.targetType as Entity["targetType"],
    name: row.name,
    domain: row.domain,
    website: row.website,
    phone: row.phone,
    email: row.email,
    address: {
      street: row.street,
      house_number: row.houseNumber,
      postal_code: row.postalCode,
      city: row.city,
      region: row.region,
      country: row.countryCode,
    },
    geo: row.lat !== null && row.lon !== null ? { lat: row.lat, lon: row.lon } : null,
    signals: {},
  }
}

interface CachedSignals {
  values: Record<string, unknown>
  /** Providers whose stored values are still within their TTL. */
  freshProviders: Set<string>
}

/**
 * Reads what previous runs stored.
 *
 * A row counts as fresh only when it has not expired and its provider_version
 * still matches - a provider that learned a new CMS signature should re-run even
 * though the old value has not aged out.
 */
async function loadCachedSignals(
  companyId: string,
  options: EnrichOptions,
  at: Date
): Promise<CachedSignals> {
  const providerVersions = new Map(options.plan.order.map((p) => [p.id, p.version]))

  const rows = await withWorkspace(
    { workspaceId: options.workspaceId },
    async ({ tx, scope }) =>
      tx
        .select()
        .from(enrichments)
        .where(
          scope(
            enrichments,
            and(
              eq(enrichments.companyId, companyId),
              inArray(enrichments.providerId, [...providerVersions.keys()])
            )
          )
        ),
    options.db
  )

  const values: Record<string, unknown> = {}
  const freshProviders = new Set<string>()

  for (const row of rows) {
    // Values are readable even when stale: a provider that fails today should
    // not blank a field that was measured last week.
    Object.assign(values, toSignalMap(row.values))

    const notExpired = !row.expiresAt || row.expiresAt > at
    const sameVersion = providerVersions.get(row.providerId) === row.providerVersion

    if (notExpired && sameVersion && !row.error) {
      freshProviders.add(row.providerId)
    }
  }

  return { values, freshProviders }
}

async function storeBundle(
  companyId: string,
  provider: SignalProvider,
  bundle: Awaited<ReturnType<SignalProvider["run"]>>,
  options: EnrichOptions,
  at: Date
): Promise<void> {
  const expiresAt = new Date(at.getTime() + provider.ttlDays * 24 * 60 * 60 * 1000)

  await withWorkspace(
    { workspaceId: options.workspaceId },
    async ({ tx, values }) =>
      tx
        .insert(enrichments)
        .values(
          values({
            companyId,
            providerId: provider.id,
            providerVersion: provider.version,
            values: bundle.values,
            sourceUrl: bundle.provenance.sourceUrl ?? null,
            fileId: bundle.provenance.fileId ?? null,
            error: bundle.error ?? null,
            fetchedAt: at,
            expiresAt,
          })
        )
        // One current row per company and provider; a rerun replaces it.
        .onConflictDoUpdate({
          target: [enrichments.companyId, enrichments.providerId],
          set: {
            providerVersion: provider.version,
            values: bundle.values,
            sourceUrl: bundle.provenance.sourceUrl ?? null,
            fileId: bundle.provenance.fileId ?? null,
            error: bundle.error ?? null,
            fetchedAt: at,
            expiresAt,
            updatedAt: at,
          },
        }),
    options.db
  )
}

/**
 * Reads every stored signal for one company, for GET /v1/companies/:id/signals.
 * Includes provenance, because a filter decision has to stay explainable.
 */
export async function loadCompanySignals(
  companyId: string,
  workspaceId: string,
  db: Database
): Promise<{
  values: Record<string, unknown>
  provenance: {
    providerId: string
    providerVersion: string
    fetchedAt: string
    expiresAt: string | null
    stale: boolean
    sourceUrl: string | null
    error: string | null
  }[]
}> {
  const rows = await withWorkspace(
    { workspaceId },
    async ({ tx, scope }) =>
      tx
        .select()
        .from(enrichments)
        .where(scope(enrichments, eq(enrichments.companyId, companyId))),
    db
  )

  const now = new Date()
  const values: Record<string, unknown> = {}

  for (const row of rows) {
    Object.assign(values, toSignalMap(row.values))
  }

  return {
    values,
    provenance: rows.map((row) => ({
      providerId: row.providerId,
      providerVersion: row.providerVersion,
      fetchedAt: row.fetchedAt.toISOString(),
      expiresAt: row.expiresAt?.toISOString() ?? null,
      stale: row.expiresAt ? row.expiresAt <= now : false,
      sourceUrl: row.sourceUrl,
      error: row.error,
    })),
  }
}

/** Companies that still need work, so a rerun can skip the fresh ones. */
export async function findStaleCompanies(
  workspaceId: string,
  providerIds: readonly string[],
  db: Database,
  limit = 500
): Promise<string[]> {
  if (providerIds.length === 0) return []

  // Parameterized rather than interpolated: provider ids come from our own
  // registry today, but building SQL by string concatenation is a habit that
  // eventually meets user input.
  const idList = sql.join(
    providerIds.map((id) => sql`${id}`),
    sql`, `
  )

  const rows = await withWorkspace(
    { workspaceId },
    async ({ tx, scope }) =>
      tx
        .select({ id: companies.id })
        .from(companies)
        .where(
          scope(
            companies,
            sql`not exists (
              select 1 from ${enrichments}
              where ${enrichments.companyId} = ${companies.id}
                and ${enrichments.providerId} in (${idList})
                and (${enrichments.expiresAt} is null or ${enrichments.expiresAt} > now())
                and ${enrichments.error} is null
            )`
          )
        )
        .limit(limit),
    db
  )

  return rows.map((row) => row.id)
}
