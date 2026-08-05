import { Worker, type Job } from "bullmq"
import { type Redis } from "ioredis"
import { eq } from "drizzle-orm"
import { searchRunEvents, searchRuns, searches, withWorkspace, type Database } from "@alg/db"
import { runDiscovery, type DiscoveryRegistry, type ProgressEvent } from "@alg/core"
import { SearchSpecSchema, type Env } from "@alg/shared"
import { QUEUE_NAMES } from "./queues.js"
import { buildRegistry } from "./registry.js"

/**
 * Consumes the discovery queue.
 *
 * Every progress event is written to search_run_events before the SSE endpoint
 * can serve it. That indirection is deliberate: the worker and the API are
 * separate processes, and a client that reconnects mid-run has to be able to
 * catch up on what it missed.
 */

export interface DiscoveryJobData {
  runId: string
  searchId: string | null
  workspaceId: string
  spec: unknown
  budgetEur?: number
}

export interface DiscoveryWorkerOptions {
  connection: Redis
  db: Database
  env: Env
  logger: {
    info(obj: unknown, msg?: string): void
    warn(obj: unknown, msg?: string): void
    error(obj: unknown, msg?: string): void
  }
  registry?: DiscoveryRegistry
}

export function createDiscoveryWorker(options: DiscoveryWorkerOptions): Worker<DiscoveryJobData> {
  const registry = options.registry ?? buildRegistry(options.env)

  const worker = new Worker<DiscoveryJobData>(
    QUEUE_NAMES.DISCOVERY,
    async (job: Job<DiscoveryJobData>) => {
      const { runId, workspaceId, searchId } = job.data
      const ctx = { workspaceId }
      let sequence = 0

      const emit = async (type: string, payload: unknown): Promise<void> => {
        sequence++
        await withWorkspace(
          ctx,
          async ({ tx, values }) =>
            tx
              .insert(searchRunEvents)
              .values(values({ runId, sequence, type, payload }))
              .onConflictDoNothing(),
          options.db
        )
      }

      const spec = SearchSpecSchema.parse(job.data.spec)

      await withWorkspace(
        ctx,
        async ({ tx, scope }) =>
          tx
            .update(searchRuns)
            .set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
            .where(scope(searchRuns, eq(searchRuns.id, runId))),
        options.db
      )

      const selections = registry.select(spec)
      await emit("plan", {
        adapters: selections.map((s) => ({
          adapter_id: s.adapter.id,
          pushed_down: s.pushedDown,
          post_filtered: s.postFiltered,
        })),
      })

      try {
        const result = await runDiscovery({
          spec,
          workspaceId,
          runId,
          registry,
          db: options.db,
          ...(job.data.budgetEur !== undefined ? { budgetEur: job.data.budgetEur } : {}),
          onProgress: async (event: ProgressEvent) => {
            await emit(event.type, event)
            // Also surface it on the job, so BullMQ's own tooling shows progress.
            await job.updateProgress({ type: event.type })
          },
        })

        await withWorkspace(
          ctx,
          async ({ tx, scope }) =>
            tx
              .update(searchRuns)
              .set({
                status: "completed",
                entitiesFound: result.found,
                entitiesNew: result.created,
                entitiesDuplicate: result.duplicates,
                // Cents, rounded up: never under-report what was spent.
                costCents: Math.ceil(result.costEur * 100),
                plan: result.adapters,
                // Neue wie wiedergefundene: beides ist Ergebnis dieses Laufs.
                // Dedupliziert, weil zwei Quellen dieselbe Firma liefern koennen.
                companyIds: [...new Set(result.outcomes.map((outcome) => outcome.companyId))],
                finishedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(scope(searchRuns, eq(searchRuns.id, runId))),
          options.db
        )

        if (searchId) {
          await withWorkspace(
            ctx,
            async ({ tx, scope }) =>
              tx
                .update(searches)
                .set({ lastRunAt: new Date(), updatedAt: new Date() })
                .where(scope(searches, eq(searches.id, searchId))),
            options.db
          )
        }

        await emit("completed", {
          found: result.found,
          new: result.created,
          duplicates: result.duplicates,
          cost_eur: result.costEur,
          adapters: result.adapters,
        })

        options.logger.info(
          { runId, found: result.found, created: result.created },
          "discovery run finished"
        )

        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)

        await withWorkspace(
          ctx,
          async ({ tx, scope }) =>
            tx
              .update(searchRuns)
              .set({
                status: "failed",
                errorKey: "discovery_failed",
                errorDetail: message,
                finishedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(scope(searchRuns, eq(searchRuns.id, runId))),
          options.db
        )

        await emit("failed", { key: "discovery_failed", detail: message })
        options.logger.error({ runId, err: error }, "discovery run failed")
        throw error
      }
    },
    {
      connection: options.connection,
      // Discovery is network-bound and hits rate-limited third-party APIs;
      // running many at once would trip their limits rather than go faster.
      concurrency: 2,
    }
  )

  worker.on("failed", (job, error) => {
    options.logger.error({ jobId: job?.id, err: error }, "discovery job failed")
  })

  return worker
}
