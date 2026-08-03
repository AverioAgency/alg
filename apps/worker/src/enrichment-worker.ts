import { Worker, type Job } from "bullmq"
import { type Redis } from "ioredis"
import { eq } from "drizzle-orm"
import { enrichmentRuns, withWorkspace, type Database } from "@alg/db"
import { enrichCompanies, planSignals, type SignalRegistry } from "@alg/core"
import { RubricSchema, SearchSpecSchema, type Env } from "@alg/shared"
import { buildSignalRegistry } from "@alg/adapters-signals"
import { QUEUE_NAMES } from "./queues.js"

/**
 * Consumes the enrichment queue.
 *
 * The planner decides what runs; this only executes it. That separation is what
 * makes the "nothing runs unless referenced" property hold at runtime rather
 * than just in tests - the worker has no way to run a provider the plan omitted.
 */

export interface EnrichmentJobData {
  runId: string
  workspaceId: string
  companyIds: string[]
  /** The search whose filters reference signals. */
  spec?: unknown
  rubric?: unknown
  templateVariables?: string[]
  force?: boolean
}

export interface EnrichmentWorkerOptions {
  connection: Redis
  db: Database
  env: Env
  logger: {
    info(obj: unknown, msg?: string): void
    warn(obj: unknown, msg?: string): void
    error(obj: unknown, msg?: string): void
    debug(obj: unknown, msg?: string): void
  }
  registry?: SignalRegistry
}

export function createEnrichmentWorker(
  options: EnrichmentWorkerOptions
): Worker<EnrichmentJobData> {
  const registry =
    options.registry ?? buildSignalRegistry({ userAgent: options.env.ALG_USER_AGENT })

  const worker = new Worker<EnrichmentJobData>(
    QUEUE_NAMES.ENRICHMENT,
    async (job: Job<EnrichmentJobData>) => {
      const { runId, workspaceId, companyIds } = job.data
      const ctx = { workspaceId }

      const spec = job.data.spec
        ? SearchSpecSchema.parse(job.data.spec)
        : // No spec means enrichment was triggered directly; the rubric and
          // template variables then carry all the references.
          { targetType: "company" as const, filters: { op: "and" as const, children: [] } }

      const rubric = job.data.rubric ? RubricSchema.parse(job.data.rubric) : null

      const plan = planSignals(
        {
          spec,
          rubric,
          ...(job.data.templateVariables ? { templateVariables: job.data.templateVariables } : {}),
        },
        registry
      )

      await withWorkspace(
        ctx,
        async ({ tx, scope }) =>
          tx
            .update(enrichmentRuns)
            .set({
              status: "running",
              plan: plan.order.map((p) => ({
                provider_id: p.id,
                version: p.version,
                cost_per_entity: p.cost.amount,
              })),
              referencedKeys: [
                ...plan.references.fromFilters,
                ...plan.references.fromRubric,
                ...plan.references.fromTemplates,
              ],
              companiesTotal: companyIds.length,
              startedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(scope(enrichmentRuns, eq(enrichmentRuns.id, runId))),
        options.db
      )

      // Nothing referenced a signal, so nothing runs. Completing immediately is
      // the correct outcome, not an error.
      if (plan.empty) {
        await finish(options.db, ctx, runId, {
          companiesDone: 0,
          providersRun: 0,
          cacheHits: 0,
        })
        options.logger.info({ runId }, "enrichment run had nothing to do")
        return { providersRun: 0, note: "no signals referenced" }
      }

      try {
        const result = await enrichCompanies({
          workspaceId,
          companyIds,
          plan,
          db: options.db,
          runId,
          logger: options.logger,
          ...(job.data.force !== undefined ? { force: job.data.force } : {}),
          onProgress: async (event) => {
            if (event.type === "company_done") {
              await job.updateProgress({
                done: event.index + 1,
                total: event.total,
              })
              // Persist periodically rather than per company: the SSE consumer
              // polls, and a write per company would be pure overhead.
              if ((event.index + 1) % 10 === 0) {
                await withWorkspace(
                  ctx,
                  async ({ tx, scope }) =>
                    tx
                      .update(enrichmentRuns)
                      .set({ companiesDone: event.index + 1, updatedAt: new Date() })
                      .where(scope(enrichmentRuns, eq(enrichmentRuns.id, runId))),
                  options.db
                )
              }
            }
          },
        })

        await finish(options.db, ctx, runId, result)

        options.logger.info(
          {
            runId,
            companies: result.companiesDone,
            providers: result.providersRun,
            cacheHits: result.cacheHits,
            failures: result.failures.length,
          },
          "enrichment run finished"
        )

        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)

        await withWorkspace(
          ctx,
          async ({ tx, scope }) =>
            tx
              .update(enrichmentRuns)
              .set({
                status: "failed",
                errorKey: "enrichment_failed",
                errorDetail: message,
                finishedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(scope(enrichmentRuns, eq(enrichmentRuns.id, runId))),
          options.db
        )

        options.logger.error({ runId, err: error }, "enrichment run failed")
        throw error
      }
    },
    {
      connection: options.connection,
      // Crawling is network-bound and the per-host limit lives in the crawler,
      // so a little concurrency here is safe.
      concurrency: 3,
    }
  )

  worker.on("failed", (job, error) => {
    options.logger.error({ jobId: job?.id, err: error }, "enrichment job failed")
  })

  return worker
}

async function finish(
  db: Database,
  ctx: { workspaceId: string },
  runId: string,
  result: { companiesDone: number; providersRun: number; cacheHits: number }
): Promise<void> {
  await withWorkspace(
    ctx,
    async ({ tx, scope }) =>
      tx
        .update(enrichmentRuns)
        .set({
          status: "completed",
          companiesDone: result.companiesDone,
          providersRun: result.providersRun,
          cacheHits: result.cacheHits,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(scope(enrichmentRuns, eq(enrichmentRuns.id, runId))),
    db
  )
}
