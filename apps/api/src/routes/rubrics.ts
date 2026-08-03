import { Router, type NextFunction, type Request, type Response } from "express"
import { and, asc, desc, eq, isNotNull, sql, type SQL } from "drizzle-orm"
import { z } from "zod"
import { type Queue } from "bullmq"
import { companies, leadScores, rubrics, scoringRuns, withWorkspace, type Database } from "@alg/db"
import {
  calibrateRubric,
  LlmResponseError,
  RUBRIC_TEMPLATES,
  suggestRubric,
  type LlmClient,
  type SignalRegistry,
} from "@alg/core"
import {
  AppError,
  PROBLEM_TYPES,
  RubricSchema,
  decodeCursor,
  encodeCursor,
  type LeadScore,
  type Rubric,
} from "@alg/shared"
import { requireContext } from "../middleware/auth.js"

/**
 * Rubric CRUD, scoring runs and calibration.
 *
 * A rubric is data the user owns, so this is a plain resource. The two
 * interesting endpoints are /suggest, which drafts one from free text, and
 * /calibrate, which corrects a threshold from leads the user labelled by hand.
 */

const IdParamSchema = z.object({ id: z.uuid() })

const TargetTypeSchema = z.enum(["local_business", "company", "person", "list"])

const CreateRubricSchema = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(2000).optional(),
  target_type: TargetTypeSchema,
  definition: RubricSchema,
  template_slug: z.string().max(64).optional(),
})

const UpdateRubricSchema = CreateRubricSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: "Provide at least one field to update." }
)

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
  target_type: TargetTypeSchema.optional(),
  include_archived: z.coerce.boolean().default(false),
})

const SuggestSchema = z.object({
  description: z.string().min(10).max(4000),
  target_type: TargetTypeSchema.default("company"),
})

const ScoreRequestSchema = z.object({
  company_ids: z.array(z.uuid()).min(1).max(1000).optional(),
  all: z.boolean().default(false),
  /** Rescores companies whose score is already current for this rubric version. */
  force: z.boolean().default(false),
})

const FeedbackSchema = z.object({
  feedback: z.enum(["good", "bad"]).nullable(),
})

const LeadsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
  qualified_only: z.coerce.boolean().default(false),
})

export interface RubricsRouterOptions {
  db: Database
  registry: SignalRegistry
  scoringQueue: Queue
  /** null when ANTHROPIC_API_KEY is unset; /suggest then answers 503. */
  llmClient: LlmClient | null
}

export function createRubricsRouter(options: RubricsRouterOptions): Router {
  const router = Router()

  /** The seeded starting points, so a new workspace is not staring at a blank form. */
  router.get("/rubrics/templates", (req: Request, res: Response, next: NextFunction) => {
    try {
      requireContext(req)
      res.json({
        data: RUBRIC_TEMPLATES.map((template) => ({
          slug: template.slug,
          name_key: template.nameKey,
          description_key: template.descriptionKey,
          definition: template.rubric,
          // Surfaced per template: a template referencing a signal no provider
          // produces would silently score every lead at zero.
          references: referencedSignals(template.rubric),
        })),
      })
    } catch (error) {
      next(error)
    }
  })

  /**
   * Drafts a rubric from a free-text description.
   *
   * 503 with its own slug when no key is configured: the deployment is
   * incomplete, not broken, and the frontend should offer manual authoring
   * rather than showing a generic failure.
   */
  router.post("/rubrics/suggest", async (req: Request, res: Response, next: NextFunction) => {
    try {
      requireContext(req)
      const body = SuggestSchema.parse(req.body ?? {})

      if (!options.llmClient) {
        throw new AppError(PROBLEM_TYPES.LLM_NOT_CONFIGURED, {
          detail: "Rubric suggestion needs ANTHROPIC_API_KEY. Author the rubric manually instead.",
        })
      }

      const catalog = options.registry.signalDefs(body.target_type)

      try {
        const result = await suggestRubric({
          client: options.llmClient,
          description: body.description,
          catalog,
        })

        res.json({
          definition: result.rubric,
          // The honest part: what the description asked for that no signal can
          // express. Shown to the user rather than quietly approximated.
          not_covered: result.notCovered,
          rationale: result.rationale,
          usage: {
            input_tokens: result.usage.inputTokens,
            output_tokens: result.usage.outputTokens,
          },
        })
      } catch (error) {
        if (error instanceof LlmResponseError) {
          throw new AppError(PROBLEM_TYPES.LLM_UNAVAILABLE, { detail: error.message })
        }
        throw error
      }
    } catch (error) {
      next(error)
    }
  })

  router.post("/rubrics", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = requireContext(req)
      const body = CreateRubricSchema.parse(req.body ?? {})

      assertSignalsExist(body.definition, body.target_type, options.registry)

      const [row] = await withWorkspace(
        ctx,
        async ({ tx, values }) =>
          tx
            .insert(rubrics)
            .values(
              values({
                name: body.name,
                description: body.description ?? null,
                targetType: body.target_type,
                definition: body.definition,
                templateSlug: body.template_slug ?? null,
                version: 1,
              })
            )
            .returning(),
        options.db
      )

      res.status(201).json(toRubricResponse(row!))
    } catch (error) {
      next(error)
    }
  })

  router.get("/rubrics", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = requireContext(req)
      const query = ListQuerySchema.parse(req.query)

      const filters: SQL[] = []
      if (query.target_type) filters.push(eq(rubrics.targetType, query.target_type))
      if (!query.include_archived) filters.push(sql`${rubrics.archivedAt} is null`)

      const keyset = query.cursor ? parseCursor(query.cursor) : null
      if (query.cursor && !keyset) {
        throw new AppError(PROBLEM_TYPES.VALIDATION_FAILED, { detail: "Invalid cursor." })
      }
      if (keyset) {
        const boundary = new Date(keyset.createdAt)
        filters.push(sql`(${rubrics.createdAt}, ${rubrics.id}) < (${boundary}, ${keyset.id})`)
      }

      const rows = await withWorkspace(
        ctx,
        async ({ tx, scope }) =>
          tx
            .select()
            .from(rubrics)
            .where(scope(rubrics, ...filters))
            .orderBy(desc(rubrics.createdAt), desc(rubrics.id))
            .limit(query.limit + 1),
        options.db
      )

      const hasMore = rows.length > query.limit
      const page = hasMore ? rows.slice(0, query.limit) : rows
      const last = page.at(-1)

      res.json({
        data: page.map(toRubricResponse),
        nextCursor:
          hasMore && last
            ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
            : null,
      })
    } catch (error) {
      next(error)
    }
  })

  router.get("/rubrics/:id", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = requireContext(req)
      const { id } = IdParamSchema.parse(req.params)
      const row = await loadRubric(ctx, id, options.db)

      res.json({
        ...toRubricResponse(row),
        references: referencedSignals(parseDefinition(row.definition)),
      })
    } catch (error) {
      next(error)
    }
  })

  /**
   * Edits a rubric and bumps its version.
   *
   * Existing scores are deliberately left alone rather than deleted: they record
   * the version they were computed with, so the UI can mark them stale. Deleting
   * would lose the user's hand-labelled feedback, which is the input to
   * calibration.
   */
  router.patch("/rubrics/:id", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = requireContext(req)
      const { id } = IdParamSchema.parse(req.params)
      const body = UpdateRubricSchema.parse(req.body ?? {})

      const existing = await loadRubric(ctx, id, options.db)
      const targetType = body.target_type ?? existing.targetType

      if (body.definition) {
        assertSignalsExist(body.definition, targetType, options.registry)
      }

      const [row] = await withWorkspace(
        ctx,
        async ({ tx, scope }) =>
          tx
            .update(rubrics)
            .set({
              ...(body.name !== undefined ? { name: body.name } : {}),
              ...(body.description !== undefined ? { description: body.description } : {}),
              ...(body.target_type !== undefined ? { targetType: body.target_type } : {}),
              ...(body.definition !== undefined ? { definition: body.definition } : {}),
              // Only a definition change invalidates existing scores; renaming
              // does not, so the version stays put.
              ...(body.definition !== undefined ? { version: existing.version + 1 } : {}),
              updatedAt: new Date(),
            })
            .where(scope(rubrics, eq(rubrics.id, id)))
            .returning(),
        options.db
      )

      res.json(toRubricResponse(row!))
    } catch (error) {
      next(error)
    }
  })

  /** Archives rather than deletes: scores reference the rubric and must stay explainable. */
  router.delete("/rubrics/:id", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = requireContext(req)
      const { id } = IdParamSchema.parse(req.params)
      await loadRubric(ctx, id, options.db)

      await withWorkspace(
        ctx,
        async ({ tx, scope }) =>
          tx
            .update(rubrics)
            .set({ archivedAt: new Date(), updatedAt: new Date() })
            .where(scope(rubrics, eq(rubrics.id, id))),
        options.db
      )

      res.status(204).end()
    } catch (error) {
      next(error)
    }
  })

  /** Starts a scoring pass. Long-running, so 202 plus a run id. */
  router.post("/rubrics/:id/score", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = requireContext(req)
      const { id } = IdParamSchema.parse(req.params)
      const body = ScoreRequestSchema.parse(req.body ?? {})

      const rubric = await loadRubric(ctx, id, options.db)

      if (!body.all && (!body.company_ids || body.company_ids.length === 0)) {
        throw new AppError(PROBLEM_TYPES.VALIDATION_FAILED, {
          detail: "Provide company_ids or set all to true.",
        })
      }

      const companyIds =
        body.company_ids ?? (await allCompanyIds(ctx, rubric.targetType, options.db))

      if (companyIds.length === 0) {
        throw new AppError(PROBLEM_TYPES.VALIDATION_FAILED, { detail: "No companies to score." })
      }

      const [run] = await withWorkspace(
        ctx,
        async ({ tx, values }) =>
          tx
            .insert(scoringRuns)
            .values(values({ rubricId: id, status: "queued", companiesTotal: companyIds.length }))
            .returning(),
        options.db
      )

      const runId = run!.id

      await options.scoringQueue.add(
        "scoring.run",
        {
          runId,
          workspaceId: ctx.workspaceId,
          rubricId: id,
          companyIds,
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
        // Told up front: without a key the LLM stage is skipped and the score is
        // rule-only, which is a legitimate result rather than a failure.
        llm_stage: llmStageStatus(parseDefinition(rubric.definition), options.llmClient),
      })
    } catch (error) {
      next(error)
    }
  })

  router.get("/scoring-runs/:id", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = requireContext(req)
      const { id } = IdParamSchema.parse(req.params)

      const [run] = await withWorkspace(
        ctx,
        async ({ tx, scope }) =>
          tx
            .select()
            .from(scoringRuns)
            .where(scope(scoringRuns, eq(scoringRuns.id, id)))
            .limit(1),
        options.db
      )

      if (!run) throw new AppError(PROBLEM_TYPES.NOT_FOUND, { detail: "Run not found." })

      res.json(toScoringRunResponse(run))
    } catch (error) {
      next(error)
    }
  })

  /** The ranked lead list: what the whole pipeline exists to produce. */
  router.get("/rubrics/:id/leads", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = requireContext(req)
      const { id } = IdParamSchema.parse(req.params)
      const query = LeadsQuerySchema.parse(req.query)
      const rubric = await loadRubric(ctx, id, options.db)

      const filters: SQL[] = [eq(leadScores.rubricId, id)]
      if (query.qualified_only) filters.push(eq(leadScores.qualified, true))

      const keyset = query.cursor ? parseScoreCursor(query.cursor) : null
      if (query.cursor && !keyset) {
        throw new AppError(PROBLEM_TYPES.VALIDATION_FAILED, { detail: "Invalid cursor." })
      }
      if (keyset) {
        // Ranked by score, so the keyset is (total, id) rather than
        // (created_at, id) - paging by time would interleave the ranking.
        filters.push(sql`(${leadScores.total}, ${leadScores.id}) < (${keyset.total}, ${keyset.id})`)
      }

      const rows = await withWorkspace(
        ctx,
        async ({ tx, scope }) =>
          tx
            .select({
              score: leadScores,
              company: {
                id: companies.id,
                name: companies.name,
                domain: companies.domain,
                city: companies.city,
                phone: companies.phone,
                email: companies.email,
              },
            })
            .from(leadScores)
            .innerJoin(companies, eq(companies.id, leadScores.companyId))
            .where(scope(leadScores, ...filters))
            .orderBy(desc(leadScores.total), desc(leadScores.id))
            .limit(query.limit + 1),
        options.db
      )

      const hasMore = rows.length > query.limit
      const page = hasMore ? rows.slice(0, query.limit) : rows
      const last = page.at(-1)

      res.json({
        data: page.map((row) => ({
          ...toLeadScoreResponse(row.score),
          company: row.company,
          // Flagged rather than hidden: a stale score is still information, it
          // just must not look current.
          stale: row.score.rubricVersion !== rubric.version,
        })),
        nextCursor:
          hasMore && last ? encodeCursor({ total: last.score.total, id: last.score.id }) : null,
      })
    } catch (error) {
      next(error)
    }
  })

  /** The user's verdict on one lead. The input to calibration. */
  router.put(
    "/rubrics/:id/leads/:companyId/feedback",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const ctx = requireContext(req)
        const { id } = IdParamSchema.parse(req.params)
        const companyId = z.uuid().parse(req.params.companyId)
        const body = FeedbackSchema.parse(req.body ?? {})

        await loadRubric(ctx, id, options.db)

        const [row] = await withWorkspace(
          ctx,
          async ({ tx, scope }) =>
            tx
              .update(leadScores)
              .set({
                feedback: body.feedback,
                feedbackAt: body.feedback ? new Date() : null,
                updatedAt: new Date(),
              })
              .where(
                scope(
                  leadScores,
                  and(eq(leadScores.rubricId, id), eq(leadScores.companyId, companyId))!
                )
              )
              .returning(),
          options.db
        )

        if (!row) {
          throw new AppError(PROBLEM_TYPES.NOT_FOUND, {
            detail: "This company has not been scored with this rubric.",
          })
        }

        res.json(toLeadScoreResponse(row))
      } catch (error) {
        next(error)
      }
    }
  )

  /**
   * Suggests a corrected threshold from hand-labelled leads.
   *
   * Arithmetic rather than an LLM call: separating two labelled sets has a right
   * answer, and the user can check it.
   */
  router.get(
    "/rubrics/:id/calibration",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const ctx = requireContext(req)
        const { id } = IdParamSchema.parse(req.params)
        const rubric = await loadRubric(ctx, id, options.db)

        const rows = await withWorkspace(
          ctx,
          async ({ tx, scope }) =>
            tx
              .select()
              .from(leadScores)
              .where(
                scope(leadScores, and(eq(leadScores.rubricId, id), isNotNull(leadScores.feedback))!)
              )
              .orderBy(asc(leadScores.createdAt))
              .limit(2000),
          options.db
        )

        const result = calibrateRubric(
          parseDefinition(rubric.definition),
          rows.map((row) => ({
            score: toLeadScore(row),
            good: row.feedback === "good",
          }))
        )

        res.json({
          suggested_threshold: result.suggestedThreshold,
          current_threshold: result.currentThreshold,
          accuracy: result.accuracy,
          accuracy_at_current: result.accuracyAtCurrent,
          false_negatives: result.falseNegatives,
          false_positives: result.falsePositives,
          suspect_criteria: result.suspectCriteria.map((entry) => ({
            label: entry.label,
            signal: entry.signal,
            weight: entry.weight,
            correlation: entry.correlation,
            reason_key: entry.reasonKey,
          })),
          sample_size: result.sampleSize,
          // False means "too little labelled data to say anything" - the frontend
          // must not present the number as advice.
          reliable: result.reliable,
        })
      } catch (error) {
        next(error)
      }
    }
  )

  return router
}

/**
 * Rejects a rubric that references signals no provider produces.
 *
 * Caught at save time rather than at scoring time: such a criterion never
 * matches, so every lead scores lower than the user expects and nothing
 * indicates why.
 */
function assertSignalsExist(rubric: Rubric, targetType: string, registry: SignalRegistry): void {
  const available = new Set(
    registry
      .signalDefs(targetType as Parameters<SignalRegistry["signalDefs"]>[0])
      .map((def) => def.key)
  )
  const unknown = rubric.criteria
    .map((criterion) => criterion.signal)
    .filter((key) => !available.has(key) && !key.startsWith("core."))

  if (unknown.length > 0) {
    throw new AppError(PROBLEM_TYPES.VALIDATION_FAILED, {
      detail: `No provider produces these signals for target type "${targetType}": ${unknown.join(", ")}`,
    })
  }
}

/**
 * Reads a stored definition back into the shared contract.
 *
 * A parse rather than a cast: the column is jsonb, and a row written by an older
 * schema version would otherwise flow into the evaluator and produce a score
 * from a shape nobody validated.
 */
function parseDefinition(value: unknown): Rubric {
  const parsed = RubricSchema.safeParse(value)
  if (!parsed.success) {
    throw new AppError(PROBLEM_TYPES.INTERNAL, {
      detail: "Stored rubric definition is not valid.",
    })
  }
  return parsed.data
}

function referencedSignals(rubric: Rubric): string[] {
  return [...new Set(rubric.criteria.map((criterion) => criterion.signal))]
}

/**
 * Whether the LLM stage will actually run.
 *
 * Three distinct states the user needs told apart: the rubric has no LLM stage,
 * it has one and will run, or it has one that will be skipped for want of a key.
 */
function llmStageStatus(
  rubric: Rubric,
  client: LlmClient | null
): "not_used" | "enabled" | "skipped_no_key" {
  if ((rubric.llmCriteria ?? []).length === 0) return "not_used"
  return client ? "enabled" : "skipped_no_key"
}

async function loadRubric(
  ctx: Parameters<typeof withWorkspace>[0],
  id: string,
  db: Database
): Promise<typeof rubrics.$inferSelect> {
  const [row] = await withWorkspace(
    ctx,
    async ({ tx, scope }) =>
      tx
        .select()
        .from(rubrics)
        .where(scope(rubrics, eq(rubrics.id, id)))
        .limit(1),
    db
  )

  if (!row) throw new AppError(PROBLEM_TYPES.NOT_FOUND, { detail: "Rubric not found." })
  return row
}

async function allCompanyIds(
  ctx: Parameters<typeof withWorkspace>[0],
  targetType: string,
  db: Database
): Promise<string[]> {
  const rows = await withWorkspace(
    ctx,
    async ({ tx, scope }) =>
      tx
        .select({ id: companies.id })
        .from(companies)
        .where(scope(companies, eq(companies.targetType, targetType)))
        .limit(10_000),
    db
  )
  return rows.map((row) => row.id)
}

function parseCursor(cursor: string): { createdAt: string; id: string } | null {
  const decoded = decodeCursor(cursor)
  if (!decoded) return null
  const { createdAt, id } = decoded
  if (typeof createdAt !== "string" || typeof id !== "string") return null
  if (Number.isNaN(Date.parse(createdAt))) return null
  return { createdAt, id }
}

function parseScoreCursor(cursor: string): { total: number; id: string } | null {
  const decoded = decodeCursor(cursor)
  if (!decoded) return null
  const { total, id } = decoded
  if (typeof total !== "number" || typeof id !== "string") return null
  return { total, id }
}

function toRubricResponse(row: typeof rubrics.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    target_type: row.targetType,
    definition: row.definition,
    template_slug: row.templateSlug,
    version: row.version,
    archived_at: row.archivedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  }
}

function toLeadScoreResponse(row: typeof leadScores.$inferSelect) {
  return {
    company_id: row.companyId,
    rubric_id: row.rubricId,
    rubric_version: row.rubricVersion,
    total: row.total,
    qualified: row.qualified,
    threshold: row.threshold,
    breakdown: row.breakdown,
    llm: row.llm,
    feedback: row.feedback,
    scored_at: row.scoredAt.toISOString(),
  }
}

/** Back into the shared contract, so calibration works on the same shape the evaluator produced. */
function toLeadScore(row: typeof leadScores.$inferSelect): LeadScore {
  return {
    total: row.total,
    qualified: row.qualified,
    threshold: row.threshold,
    breakdown: row.breakdown as LeadScore["breakdown"],
    llm: (row.llm as LeadScore["llm"]) ?? null,
  }
}

function toScoringRunResponse(row: typeof scoringRuns.$inferSelect) {
  return {
    id: row.id,
    rubric_id: row.rubricId,
    status: row.status,
    companies_total: row.companiesTotal,
    companies_done: row.companiesDone,
    qualified_count: row.qualifiedCount,
    llm_calls: row.llmCalls,
    llm_tokens: { input: row.llmInputTokens, output: row.llmOutputTokens },
    error: row.errorKey ? { key: row.errorKey, detail: row.errorDetail } : null,
    started_at: row.startedAt?.toISOString() ?? null,
    finished_at: row.finishedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  }
}
