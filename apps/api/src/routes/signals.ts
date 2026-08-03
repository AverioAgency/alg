import { Router, type NextFunction, type Request, type Response } from "express"
import { desc, eq } from "drizzle-orm"
import { z } from "zod"
import { type Queue } from "bullmq"
import { companies, enrichmentRuns, withWorkspace, type Database } from "@alg/db"
import { estimateSignalCost, loadCompanySignals, planSignals, type SignalRegistry } from "@alg/core"
import { AppError, PROBLEM_TYPES, RubricSchema, SearchSpecSchema } from "@alg/shared"
import { requireContext } from "../middleware/auth.js"

/**
 * The signal layer's HTTP surface.
 *
 * Includes a preview endpoint that resolves the plan without running anything,
 * because the user has to be able to see what a run would cost before paying for
 * it - and which criterion is responsible for the bulk of it.
 */

const IdParamSchema = z.object({ id: z.uuid() })

const EnrichRequestSchema = z.object({
  company_ids: z.array(z.uuid()).min(1).max(1000).optional(),
  /** Enriches everything in the workspace when no ids are given. */
  all: z.boolean().default(false),
  spec: SearchSpecSchema.optional(),
  rubric: RubricSchema.optional(),
  template_variables: z.array(z.string().min(1)).optional(),
  /** Ignores cached values that are still fresh. */
  force: z.boolean().default(false),
})

const PreviewRequestSchema = z.object({
  spec: SearchSpecSchema.optional(),
  rubric: RubricSchema.optional(),
  template_variables: z.array(z.string().min(1)).optional(),
  entities: z.number().int().positive().max(100_000).default(100),
})

export interface SignalsRouterOptions {
  db: Database
  registry: SignalRegistry
  enrichmentQueue: Queue
}

export function createSignalsRouter(options: SignalsRouterOptions): Router {
  const router = Router()

  /** Everything ALG knows about a company, with provenance. */
  router.get("/companies/:id/signals", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = requireContext(req)
      const { id } = IdParamSchema.parse(req.params)

      const [company] = await withWorkspace(
        ctx,
        async ({ tx, scope }) =>
          tx
            .select({ id: companies.id, name: companies.name })
            .from(companies)
            .where(scope(companies, eq(companies.id, id)))
            .limit(1),
        options.db
      )

      if (!company) {
        throw new AppError(PROBLEM_TYPES.NOT_FOUND, { detail: "Company not found." })
      }

      const signals = await loadCompanySignals(id, ctx.workspaceId, options.db)

      res.json({
        company_id: id,
        values: signals.values,
        // Provenance is not optional decoration: a filter decision has to stay
        // explainable, and Art. 14 requires naming the source.
        provenance: signals.provenance,
      })
    } catch (error) {
      next(error)
    }
  })

  /** What the registry can produce, for the filter UI. */
  router.get("/signals/schema", (req: Request, res: Response, next: NextFunction) => {
    try {
      requireContext(req)
      const targetType = z
        .enum(["local_business", "company", "person", "list"])
        .optional()
        .parse(req.query.target_type)

      res.json({
        providers: options.registry.describe(targetType),
        signals: options.registry.signalDefs(targetType),
      })
    } catch (error) {
      next(error)
    }
  })

  /**
   * Resolves the plan without running it.
   *
   * The whole point of demand-driven execution is visible here: a spec that
   * references nothing returns an empty plan and a cost of zero.
   */
  router.post("/signals/preview", (req: Request, res: Response, next: NextFunction) => {
    try {
      requireContext(req)
      const body = PreviewRequestSchema.parse(req.body ?? {})

      const spec = body.spec ?? {
        targetType: "company" as const,
        filters: { op: "and" as const, children: [] },
      }

      const plan = planSignals(
        {
          spec,
          rubric: body.rubric ?? null,
          ...(body.template_variables ? { templateVariables: body.template_variables } : {}),
        },
        options.registry
      )

      const cost = estimateSignalCost(plan, body.entities)

      res.json({
        providers: plan.order.map((p) => ({
          provider_id: p.id,
          version: p.version,
          cost_per_entity_eur: p.cost.amount,
          ttl_days: p.ttlDays,
          depends_on: p.dependsOn,
        })),
        references: {
          from_filters: plan.references.fromFilters,
          from_rubric: plan.references.fromRubric,
          from_templates: plan.references.fromTemplates,
        },
        core_keys: plan.coreKeys,
        transitive: plan.transitive,
        unresolved: plan.unresolved,
        empty: plan.empty,
        cost: {
          entities: cost.entities,
          per_entity_eur: cost.costPerEntityEur,
          total_eur: cost.totalEur,
          per_provider: cost.perProvider.map((p) => ({
            provider_id: p.providerId,
            per_entity_eur: p.costPerEntityEur,
            total_eur: p.totalEur,
          })),
        },
      })
    } catch (error) {
      next(error)
    }
  })

  /** Starts an enrichment run. Long-running, so 202 plus a run id. */
  router.post("/enrichments", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = requireContext(req)
      const body = EnrichRequestSchema.parse(req.body ?? {})

      if (!body.all && (!body.company_ids || body.company_ids.length === 0)) {
        throw new AppError(PROBLEM_TYPES.VALIDATION_FAILED, {
          detail: "Provide company_ids or set all to true.",
        })
      }

      const companyIds = body.company_ids ?? (await allCompanyIds(ctx, options.db))

      if (companyIds.length === 0) {
        throw new AppError(PROBLEM_TYPES.VALIDATION_FAILED, {
          detail: "No companies to enrich.",
        })
      }

      const [run] = await withWorkspace(
        ctx,
        async ({ tx, values }) =>
          tx
            .insert(enrichmentRuns)
            .values(values({ status: "queued", companiesTotal: companyIds.length }))
            .returning(),
        options.db
      )

      const runId = run!.id

      await options.enrichmentQueue.add(
        "enrichment.run",
        {
          runId,
          workspaceId: ctx.workspaceId,
          companyIds,
          spec: body.spec,
          rubric: body.rubric,
          templateVariables: body.template_variables,
          force: body.force,
        },
        {
          jobId: runId,
          attempts: 2,
          backoff: { type: "exponential", delay: 15_000 },
          removeOnComplete: { age: 86_400 },
          removeOnFail: { age: 7 * 86_400 },
        }
      )

      res.status(202).json({
        run_id: runId,
        status: "queued",
        companies: companyIds.length,
      })
    } catch (error) {
      next(error)
    }
  })

  router.get("/enrichments/:id", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = requireContext(req)
      const { id } = IdParamSchema.parse(req.params)

      const [run] = await withWorkspace(
        ctx,
        async ({ tx, scope }) =>
          tx
            .select()
            .from(enrichmentRuns)
            .where(scope(enrichmentRuns, eq(enrichmentRuns.id, id)))
            .limit(1),
        options.db
      )

      if (!run) throw new AppError(PROBLEM_TYPES.NOT_FOUND, { detail: "Run not found." })

      res.json(toRunResponse(run))
    } catch (error) {
      next(error)
    }
  })

  router.get("/enrichments", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = requireContext(req)
      const limit = z.coerce.number().int().min(1).max(200).default(50).parse(req.query.limit)

      const rows = await withWorkspace(
        ctx,
        async ({ tx, scope }) =>
          tx
            .select()
            .from(enrichmentRuns)
            .where(scope(enrichmentRuns))
            .orderBy(desc(enrichmentRuns.createdAt), desc(enrichmentRuns.id))
            .limit(limit),
        options.db
      )

      res.json({ data: rows.map(toRunResponse), nextCursor: null })
    } catch (error) {
      next(error)
    }
  })

  return router
}

async function allCompanyIds(ctx: { workspaceId: string }, db: Database): Promise<string[]> {
  const rows = await withWorkspace(
    ctx,
    async ({ tx, scope }) =>
      tx.select({ id: companies.id }).from(companies).where(scope(companies)).limit(1000),
    db
  )
  return rows.map((row) => row.id)
}

function toRunResponse(row: typeof enrichmentRuns.$inferSelect) {
  return {
    id: row.id,
    status: row.status,
    plan: row.plan,
    referenced_keys: row.referencedKeys,
    companies_total: row.companiesTotal,
    companies_done: row.companiesDone,
    providers_run: row.providersRun,
    cache_hits: row.cacheHits,
    error: row.errorKey ? { key: row.errorKey, detail: row.errorDetail } : null,
    started_at: row.startedAt?.toISOString() ?? null,
    finished_at: row.finishedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  }
}
