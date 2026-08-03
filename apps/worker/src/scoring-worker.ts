import { Worker, type Job } from "bullmq"
import { type Redis } from "ioredis"
import { eq } from "drizzle-orm"
import { rubrics, scoringRuns, withWorkspace, type Database } from "@alg/db"
import { createLlmClientFromEnv, scoreCompanies, type LlmClient } from "@alg/core"
import { RubricSchema, type Env } from "@alg/shared"
import { QUEUE_NAMES } from "./queues.js"

/**
 * Consumes the scoring queue.
 *
 * Scoring never fetches anything: it reads signals the enrichment layer already
 * stored. A missing signal produces a "not measured" breakdown entry rather than
 * triggering a crawl - otherwise a scoring pass would silently become an
 * enrichment pass, with the cost that implies.
 */

export interface ScoringJobData {
  runId: string
  workspaceId: string
  rubricId: string
  companyIds: string[]
  force?: boolean
}

export interface ScoringWorkerOptions {
  connection: Redis
  db: Database
  env: Env
  logger: {
    info(obj: unknown, msg?: string): void
    warn(obj: unknown, msg?: string): void
    error(obj: unknown, msg?: string): void
    debug(obj: unknown, msg?: string): void
  }
  /** Injectable for tests; falls back to the env-configured client (null without a key). */
  llmClient?: LlmClient | null
}

export function createScoringWorker(options: ScoringWorkerOptions): Worker<ScoringJobData> {
  const llmClient =
    options.llmClient !== undefined ? options.llmClient : createLlmClientFromEnv(options.env)

  const worker = new Worker<ScoringJobData>(
    QUEUE_NAMES.SCORING,
    async (job: Job<ScoringJobData>) => {
      const { runId, workspaceId, rubricId, companyIds } = job.data
      const ctx = { workspaceId }

      const [rubricRow] = await withWorkspace(
        ctx,
        async ({ tx, scope }) =>
          tx
            .select()
            .from(rubrics)
            .where(scope(rubrics, eq(rubrics.id, rubricId)))
            .limit(1),
        options.db
      )

      if (!rubricRow) {
        await fail(options.db, ctx, runId, "rubric_not_found", `Rubric ${rubricId} is gone.`)
        options.logger.error({ runId, rubricId }, "scoring run referenced a missing rubric")
        return { companiesDone: 0 }
      }

      const rubric = RubricSchema.parse(rubricRow.definition)

      await withWorkspace(
        ctx,
        async ({ tx, scope }) =>
          tx
            .update(scoringRuns)
            .set({
              status: "running",
              companiesTotal: companyIds.length,
              startedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(scope(scoringRuns, eq(scoringRuns.id, runId))),
        options.db
      )

      try {
        const result = await scoreCompanies({
          workspaceId,
          rubricId,
          rubric,
          rubricVersion: rubricRow.version,
          companyIds,
          db: options.db,
          llmClient,
          logger: options.logger,
          ...(job.data.force !== undefined ? { force: job.data.force } : {}),
          onProgress: async (event) => {
            await job.updateProgress({ done: event.index + 1, total: event.total })

            // Persisted every 10 rather than per company: the SSE consumer polls,
            // so a write per company would be pure overhead.
            if ((event.index + 1) % 10 === 0) {
              await withWorkspace(
                ctx,
                async ({ tx, scope }) =>
                  tx
                    .update(scoringRuns)
                    .set({ companiesDone: event.index + 1, updatedAt: new Date() })
                    .where(scope(scoringRuns, eq(scoringRuns.id, runId))),
                options.db
              )
            }
          },
        })

        await withWorkspace(
          ctx,
          async ({ tx, scope }) =>
            tx
              .update(scoringRuns)
              .set({
                status: "completed",
                companiesDone: result.companiesDone,
                qualifiedCount: result.qualifiedCount,
                llmCalls: result.llmCalls,
                llmInputTokens: result.llmInputTokens,
                llmOutputTokens: result.llmOutputTokens,
                finishedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(scope(scoringRuns, eq(scoringRuns.id, runId))),
          options.db
        )

        options.logger.info(
          {
            runId,
            companies: result.companiesDone,
            qualified: result.qualifiedCount,
            skipped: result.skipped,
            llmCalls: result.llmCalls,
            llmFailures: result.llmFailures.length,
          },
          "scoring run finished"
        )

        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await fail(options.db, ctx, runId, "scoring_failed", message)
        options.logger.error({ runId, err: error }, "scoring run failed")
        throw error
      }
    },
    {
      connection: options.connection,
      // Rule-only scoring is CPU and database bound; with an LLM stage it is
      // network bound. Either way a small amount of concurrency is safe, and the
      // API rate limit is the real ceiling.
      concurrency: 3,
    }
  )

  worker.on("failed", (job, error) => {
    options.logger.error({ jobId: job?.id, err: error }, "scoring job failed")
  })

  return worker
}

async function fail(
  db: Database,
  ctx: { workspaceId: string },
  runId: string,
  key: string,
  detail: string
): Promise<void> {
  await withWorkspace(
    ctx,
    async ({ tx, scope }) =>
      tx
        .update(scoringRuns)
        .set({
          status: "failed",
          errorKey: key,
          errorDetail: detail,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(scope(scoringRuns, eq(scoringRuns.id, runId))),
    db
  )
}
