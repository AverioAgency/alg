import { Router, type NextFunction, type Request, type Response } from "express"
import { desc, eq, sql, type SQL } from "drizzle-orm"
import { z } from "zod"
import { type Queue } from "bullmq"
import { searchRuns, searches, withWorkspace, type Database } from "@alg/db"
import { findUnknownFilterKeys, type SignalRegistry } from "@alg/core"
import { AppError, PROBLEM_TYPES, SearchSpecSchema, decodeCursor, encodeCursor } from "@alg/shared"
import { requireContext } from "../middleware/auth.js"

/**
 * Search definitions and their executions.
 *
 * A run is a long-running operation: the endpoint returns 202 with a run id
 * immediately and the work happens in the discovery queue. Progress arrives over
 * SSE on /v1/streams/:runId rather than by polling.
 */

const IdParamSchema = z.object({ id: z.uuid() })

const CreateSearchSchema = z.object({
  name: z.string().min(1).max(200),
  spec: SearchSpecSchema,
  is_monitor: z.boolean().default(false),
  /** Standard five-field cron. Only meaningful together with is_monitor. */
  monitor_cron: z
    .string()
    .regex(/^(\S+\s+){4}\S+$/, "must be a five-field cron expression")
    .optional(),
})

const UpdateSearchSchema = CreateSearchSchema.partial()

const RunSearchSchema = z.object({
  /** Overrides the saved limit for this one run. */
  limit: z.number().int().min(1).max(10_000).optional(),
  /** Hard ceiling for paid adapters; the run stops rather than exceeding it. */
  budget_eur: z.number().nonnegative().optional(),
})

const ListQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export interface SearchesRouterOptions {
  db: Database
  discoveryQueue: Queue
  /** Fuer die Schluesselpruefung: nur sie kennt die tatsaechlichen Signalnamen. */
  signalRegistry: SignalRegistry
}

export function createSearchesRouter(options: SearchesRouterOptions): Router {
  const router = Router()

  /**
   * Weist eine Suche mit erfundenen Filterschluesseln ab.
   *
   * Ohne diese Pruefung ist ein Tippfehler oder ein geratener Name folgenlos -
   * bis zum Lauf: kein Adapter bedient den Schluessel, der Nachfilter findet
   * keinen Wert und verwirft jeden Treffer. Der Nutzer sieht "0 Leads" und
   * nichts sonst. Hier ist der letzte Moment, in dem jemand zusieht.
   */
  const assertKnownFilterKeys = (spec: { filters: Parameters<typeof findUnknownFilterKeys>[0] }) => {
    const unknown = findUnknownFilterKeys(spec.filters, options.signalRegistry)
    if (unknown.length === 0) return

    throw new AppError(PROBLEM_TYPES.VALIDATION_FAILED, {
      detail:
        `Unbekannte Filterschlüssel: ${unknown.map((entry) => entry.key).join(", ")}. ` +
        "GET /v1/filters/schema listet alle verfügbaren Felder.",
      errors: unknown.map((entry) => ({
        path: `spec.filters.${entry.key}`,
        message:
          entry.didYouMean.length > 0
            ? `Unbekannt. Meintest du ${entry.didYouMean.join(", ")}?`
            : "Unbekannt - siehe GET /v1/filters/schema.",
      })),
    })
  }

  router.post("/searches", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = requireContext(req)
      const body = CreateSearchSchema.parse(req.body)

      if (body.is_monitor && !body.monitor_cron) {
        throw new AppError(PROBLEM_TYPES.VALIDATION_FAILED, {
          detail: "monitor_cron is required when is_monitor is true.",
        })
      }

      assertKnownFilterKeys(body.spec)

      const [created] = await withWorkspace(
        ctx,
        async ({ tx, values }) =>
          tx
            .insert(searches)
            .values(
              values({
                name: body.name,
                targetType: body.spec.targetType,
                spec: body.spec,
                sources: body.spec.sources ?? null,
                isMonitor: body.is_monitor,
                monitorCron: body.monitor_cron ?? null,
              })
            )
            .returning(),
        options.db
      )

      res.status(201).json(toSearchResponse(created!))
    } catch (error) {
      next(error)
    }
  })

  router.get("/searches", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = requireContext(req)
      const query = ListQuerySchema.parse(req.query)

      const filters: SQL[] = []
      const keyset = query.cursor ? parseCursor(query.cursor) : null
      if (query.cursor && !keyset) {
        throw new AppError(PROBLEM_TYPES.VALIDATION_FAILED, { detail: "Invalid cursor." })
      }
      if (keyset) {
        filters.push(
          sql`(${searches.createdAt}, ${searches.id}) < (${new Date(keyset.createdAt)}, ${keyset.id})`
        )
      }

      const rows = await withWorkspace(
        ctx,
        async ({ tx, scope }) =>
          tx
            .select()
            .from(searches)
            .where(scope(searches, ...filters))
            .orderBy(desc(searches.createdAt), desc(searches.id))
            .limit(query.limit + 1),
        options.db
      )

      const hasMore = rows.length > query.limit
      const page = hasMore ? rows.slice(0, query.limit) : rows
      const last = page.at(-1)

      res.json({
        data: page.map(toSearchResponse),
        nextCursor:
          hasMore && last
            ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
            : null,
      })
    } catch (error) {
      next(error)
    }
  })

  router.get("/searches/:id", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = requireContext(req)
      const { id } = IdParamSchema.parse(req.params)
      const search = await loadSearch(options.db, ctx, id)
      res.json(toSearchResponse(search))
    } catch (error) {
      next(error)
    }
  })

  router.patch("/searches/:id", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = requireContext(req)
      const { id } = IdParamSchema.parse(req.params)
      const body = UpdateSearchSchema.parse(req.body)
      await loadSearch(options.db, ctx, id)

      // Auch beim Aendern: sonst waere die Pruefung beim Anlegen nur eine Huerde,
      // die ein zweiter Aufruf umgeht.
      if (body.spec !== undefined) assertKnownFilterKeys(body.spec)

      const [updated] = await withWorkspace(
        ctx,
        async ({ tx, scope }) =>
          tx
            .update(searches)
            .set({
              ...(body.name !== undefined ? { name: body.name } : {}),
              ...(body.spec !== undefined
                ? { spec: body.spec, targetType: body.spec.targetType }
                : {}),
              ...(body.is_monitor !== undefined ? { isMonitor: body.is_monitor } : {}),
              ...(body.monitor_cron !== undefined ? { monitorCron: body.monitor_cron } : {}),
              updatedAt: new Date(),
            })
            .where(scope(searches, eq(searches.id, id)))
            .returning(),
        options.db
      )

      res.json(toSearchResponse(updated!))
    } catch (error) {
      next(error)
    }
  })

  router.delete("/searches/:id", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = requireContext(req)
      const { id } = IdParamSchema.parse(req.params)
      await loadSearch(options.db, ctx, id)

      // search_runs references this with ON DELETE SET NULL: the history of what
      // a run found and cost survives the definition being removed.
      await withWorkspace(
        ctx,
        async ({ tx, scope }) => tx.delete(searches).where(scope(searches, eq(searches.id, id))),
        options.db
      )

      res.status(204).end()
    } catch (error) {
      next(error)
    }
  })

  /** Long-running: returns 202 and a run id, progress over SSE. */
  router.post("/searches/:id/run", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = requireContext(req)
      const { id } = IdParamSchema.parse(req.params)
      const body = RunSearchSchema.parse(req.body ?? {})
      const search = await loadSearch(options.db, ctx, id)

      const spec = SearchSpecSchema.parse(search.spec)
      const effectiveSpec = body.limit ? { ...spec, limit: body.limit } : spec

      const [run] = await withWorkspace(
        ctx,
        async ({ tx, values }) =>
          tx
            .insert(searchRuns)
            .values(values({ searchId: id, status: "queued", spec: effectiveSpec }))
            .returning(),
        options.db
      )

      const runId = run!.id

      await options.discoveryQueue.add(
        "discovery.run",
        {
          runId,
          searchId: id,
          workspaceId: ctx.workspaceId,
          spec: effectiveSpec,
          budgetEur: body.budget_eur,
        },
        {
          // The run id is also the job id, so a retried request cannot enqueue
          // the same run twice.
          jobId: runId,
          attempts: 2,
          backoff: { type: "exponential", delay: 10_000 },
          removeOnComplete: { age: 86_400 },
          removeOnFail: { age: 7 * 86_400 },
        }
      )

      res.status(202).json({
        run_id: runId,
        status: "queued",
        stream_url: `/v1/streams/${runId}`,
      })
    } catch (error) {
      next(error)
    }
  })

  router.get("/searches/:id/runs", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = requireContext(req)
      const { id } = IdParamSchema.parse(req.params)
      const query = ListQuerySchema.parse(req.query)

      const rows = await withWorkspace(
        ctx,
        async ({ tx, scope }) =>
          tx
            .select()
            .from(searchRuns)
            .where(scope(searchRuns, eq(searchRuns.searchId, id)))
            .orderBy(desc(searchRuns.createdAt), desc(searchRuns.id))
            .limit(query.limit),
        options.db
      )

      res.json({ data: rows.map(toRunResponse), nextCursor: null })
    } catch (error) {
      next(error)
    }
  })

  router.get("/runs/:id", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = requireContext(req)
      const { id } = IdParamSchema.parse(req.params)

      const [run] = await withWorkspace(
        ctx,
        async ({ tx, scope }) =>
          tx
            .select()
            .from(searchRuns)
            .where(scope(searchRuns, eq(searchRuns.id, id)))
            .limit(1),
        options.db
      )

      if (!run) throw new AppError(PROBLEM_TYPES.NOT_FOUND, { detail: "Run not found." })
      res.json(toRunResponse(run))
    } catch (error) {
      next(error)
    }
  })

  return router
}

async function loadSearch(
  db: Database,
  ctx: { workspaceId: string },
  id: string
): Promise<typeof searches.$inferSelect> {
  const [row] = await withWorkspace(
    ctx,
    async ({ tx, scope }) =>
      tx
        .select()
        .from(searches)
        .where(scope(searches, eq(searches.id, id)))
        .limit(1),
    db
  )
  if (!row) throw new AppError(PROBLEM_TYPES.NOT_FOUND, { detail: "Search not found." })
  return row
}

function parseCursor(cursor: string): { createdAt: string; id: string } | null {
  const decoded = decodeCursor(cursor)
  if (!decoded) return null
  const { createdAt, id } = decoded
  if (typeof createdAt !== "string" || typeof id !== "string") return null
  if (Number.isNaN(Date.parse(createdAt))) return null
  return { createdAt, id }
}

function toSearchResponse(row: typeof searches.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    target_type: row.targetType,
    spec: row.spec,
    is_monitor: row.isMonitor,
    monitor_cron: row.monitorCron,
    last_run_at: row.lastRunAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  }
}

function toRunResponse(row: typeof searchRuns.$inferSelect) {
  return {
    id: row.id,
    search_id: row.searchId,
    status: row.status,
    entities_found: row.entitiesFound,
    entities_new: row.entitiesNew,
    entities_duplicate: row.entitiesDuplicate,
    // Money is stored in cents to avoid float drift; the wire format is euros.
    cost_eur: row.costCents / 100,
    plan: row.plan,
    error: row.errorKey ? { key: row.errorKey, detail: row.errorDetail } : null,
    started_at: row.startedAt?.toISOString() ?? null,
    finished_at: row.finishedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  }
}
