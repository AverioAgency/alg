import { Router, type NextFunction, type Request, type Response } from "express"
import { z } from "zod"
import { eq } from "drizzle-orm"
import { rubrics, searches, workspaces, withWorkspace, type Database } from "@alg/db"
import {
  applyAnswer,
  applyDefaults,
  estimateSignalCost,
  isRunnable,
  nextQuestions,
  planSignals,
  playbookBySlug,
  startClarification,
  PLAYBOOKS,
  type ClarifyState,
  type SignalRegistry,
} from "@alg/core"
import {
  AppError,
  PROBLEM_TYPES,
  RubricSchema,
  SearchSpecSchema,
  OnboardingProfileSchema,
  decodeSearchSpec,
  encodeSearchSpecToQuery,
  isOnboardingComplete,
  type OnboardingProfile,
} from "@alg/shared"
import { requireContext } from "../middleware/auth.js"

/**
 * The clarification flow: draft -> answer -> preview -> run.
 *
 * Stateless by design. The client sends the description and the answers so far,
 * the server computes the questions and the spec. No draft table, no expiry job,
 * and no half-finished wizards accumulating in the database - a user who closes
 * the tab leaves nothing behind.
 */

const TargetTypeSchema = z.enum(["local_business", "company", "person", "list"])

const AnswerSchema = z.object({
  question_id: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]),
})

const DraftSchema = z.object({
  description: z.string().min(1).max(2000),
  target_type: TargetTypeSchema.default("company"),
  answers: z.array(AnswerSchema).max(20).default([]),
})

const PreviewSchema = DraftSchema.extend({
  /** Referencing a rubric here is what makes its signals count toward the cost. */
  rubric: RubricSchema.optional(),
  /** Applies the default for every unanswered question before estimating. */
  fill_defaults: z.boolean().default(true),
  estimated_entities: z.number().int().positive().max(100_000).optional(),
})

const OnboardingPatchSchema = z.object({
  /** Partial by design: the wizard saves after each step, not once at the end. */
  profile: OnboardingProfileSchema.partial().optional(),
  /** Where the user is, so an interrupted run resumes instead of restarting. */
  last_step: z.number().int().min(1).max(20).optional(),
  /**
   * Set on the final step. Once true the timestamp is never rewritten - a later
   * save must not be able to un-finish the wizard.
   */
  completed: z.boolean().default(false),
})

export interface ClarifyRouterOptions {
  db: Database
  registry: SignalRegistry
}

export function createClarifyRouter(options: ClarifyRouterOptions): Router {
  const router = Router()

  /**
   * Returns the questions that still matter, plus the spec so far.
   *
   * Called again after every answer: the set of remaining questions depends on
   * what the spec already says, so recomputing beats tracking a cursor.
   */
  router.post("/searches/clarify", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = requireContext(req)
      const body = DraftSchema.parse(req.body ?? {})
      const profile = await loadOnboarding(ctx, options.db)
      const state = buildState(body, profile)

      const questions = nextQuestions(state)

      res.json({
        description: state.description,
        target_type: state.targetType,
        questions: questions.map(toQuestionResponse),
        spec: state.spec,
        answers: state.answers,
        // False means the search cannot run yet - it has no geographic
        // constraint, and Overpass refuses outright without one.
        runnable: isRunnable(state.spec),
        // Every remaining question has a documented default, so the client can
        // always offer "run anyway".
        skippable: questions.every((question) => question.defaultValue !== null),
      })
    } catch (error) {
      next(error)
    }
  })

  /**
   * The spec a run would use, with what it would cost.
   *
   * Deliberately separate from the run endpoint: the cost has to be visible
   * before anything is charged, and the empty-plan case - a search referencing
   * no signal, which costs nothing - is worth seeing spelled out.
   */
  router.post("/searches/preview", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = requireContext(req)
      const body = PreviewSchema.parse(req.body ?? {})

      const profile = await loadOnboarding(ctx, options.db)
      let state = buildState(body, profile)
      if (body.fill_defaults) state = applyDefaults(state)

      const plan = planSignals({ spec: state.spec, rubric: body.rubric ?? null }, options.registry)

      const entities = body.estimated_entities ?? state.spec.limit ?? 500
      const cost = estimateSignalCost(plan, entities)

      res.json({
        spec: state.spec,
        runnable: isRunnable(state.spec),
        // The shareable URL for this search, so a preview can be sent to a
        // colleague before it is run.
        share_query: encodeSearchSpecToQuery(state.spec),
        applied_defaults: body.fill_defaults
          ? nextQuestions(buildState(body, profile))
              .filter((question) => question.defaultValue !== null)
              .map((question) => ({ question_id: question.id, value: question.defaultValue }))
          : [],
        unanswered: nextQuestions(state).map((question) => question.id),
        plan: {
          providers: plan.order.map((provider) => ({
            provider_id: provider.id,
            version: provider.version,
            cost_per_entity_eur: provider.cost.amount,
          })),
          // True means no signal was referenced, so no provider runs and the
          // search is free. That is the point of demand-driven execution.
          empty: plan.empty,
          unresolved: plan.unresolved,
        },
        cost: {
          entities: cost.entities,
          per_entity_eur: cost.costPerEntityEur,
          total_eur: cost.totalEur,
        },
      })
    } catch (error) {
      next(error)
    }
  })

  /**
   * Decodes a shared search URL back into a spec.
   *
   * The other half of encodeSearchSpec: a colleague opens the link, the frontend
   * posts the query string here and gets a spec it can run or keep editing.
   */
  router.post("/searches/decode", (req: Request, res: Response, next: NextFunction) => {
    try {
      requireContext(req)
      const body = z.object({ query: z.string().min(1).max(8000) }).parse(req.body ?? {})

      const result = decodeSearchSpec(body.query)
      if (!result.spec) {
        throw new AppError(PROBLEM_TYPES.VALIDATION_FAILED, {
          detail: `Could not decode the search URL (${result.errorKey ?? "unknown"}).`,
        })
      }

      res.json({ spec: result.spec, runnable: isRunnable(result.spec) })
    } catch (error) {
      next(error)
    }
  })

  /**
   * The workspace's onboarding state.
   *
   * The frontend calls this on every visit to decide whether to offer the
   * wizard. `completed: false` with a null profile means it was never started;
   * a `completed_at` means the user reached the end and the entry point goes
   * away.
   */
  router.get("/onboarding", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = requireContext(req)
      const profile = await loadOnboarding(ctx, options.db)

      res.json({
        profile,
        completed: isOnboardingComplete(profile),
        completed_at: profile?.completedAt ?? null,
        // Where an interrupted run left off, so the wizard can resume rather
        // than restart - abandoning at step 5 and being sent back to step 1 is
        // how a wizard gets abandoned a second time.
        last_step: profile?.lastStep ?? null,
      })
    } catch (error) {
      next(error)
    }
  })

  /**
   * Saves progress, and on the last step marks the wizard done.
   *
   * Merged rather than replaced: the wizard saves after each step, and a PATCH
   * carrying only step 3 must not erase what step 2 recorded.
   */
  router.patch("/onboarding", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = requireContext(req)
      const body = OnboardingPatchSchema.parse(req.body ?? {})
      const existing = await loadOnboarding(ctx, options.db)

      const merged: OnboardingProfile = {
        ...existing,
        ...(body.profile ?? {}),
        // Nested groups merge one level down too, so saving `target` alone does
        // not drop the `offer` the previous step wrote.
        ...(body.profile?.company || existing?.company
          ? { company: { ...existing?.company, ...body.profile?.company } }
          : {}),
        ...(body.profile?.offer || existing?.offer
          ? { offer: { ...existing?.offer, ...body.profile?.offer } }
          : {}),
        ...(body.profile?.target || existing?.target
          ? { target: { ...existing?.target, ...body.profile?.target } }
          : {}),
        ...(body.last_step !== undefined ? { lastStep: body.last_step } : {}),
        // Only ever set here, never cleared by a later save: finishing the
        // wizard is not something a subsequent step should be able to undo.
        ...(body.completed
          ? { completedAt: existing?.completedAt ?? new Date().toISOString() }
          : {}),
      }

      const stored = await saveOnboarding(ctx, merged, options.db)

      res.json({
        profile: stored,
        completed: isOnboardingComplete(stored),
        completed_at: stored.completedAt ?? null,
        last_step: stored.lastStep ?? null,
      })
    } catch (error) {
      next(error)
    }
  })

  /**
   * Starts the wizard over.
   *
   * Clears the profile entirely rather than only the timestamp: a user who asks
   * to redo onboarding means the answers too, and keeping them would silently
   * pre-fill the very questions they wanted to revisit.
   */
  router.delete("/onboarding", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = requireContext(req)

      await withWorkspace(
        ctx,
        async ({ tx }) =>
          tx
            .update(workspaces)
            .set({ onboarding: null, updatedAt: new Date() })
            .where(eq(workspaces.id, ctx.workspaceId)),
        options.db
      )

      res.status(204).end()
    } catch (error) {
      next(error)
    }
  })

  /**
   * The preconfigured starting points.
   *
   * Three of them, covering three incompatible notions of a good lead - which is
   * the demonstration: one engine, no code branching on any of them.
   */
  router.get("/playbooks", (req: Request, res: Response, next: NextFunction) => {
    try {
      requireContext(req)

      res.json({
        data: PLAYBOOKS.map((playbook) => ({
          slug: playbook.slug,
          name_key: playbook.nameKey,
          description_key: playbook.descriptionKey,
          target_type: playbook.targetType,
          spec: playbook.spec,
          rubric: playbook.rubric,
          // Null rather than a placeholder: outreach sequences arrive with M5,
          // and nothing should pretend to offer messaging that does not exist.
          sequence: playbook.sequence,
          referenced_signals: playbook.referencedSignals,
          share_query: encodeSearchSpecToQuery(playbook.spec),
        })),
      })
    } catch (error) {
      next(error)
    }
  })

  /**
   * Instantiates a playbook into the workspace.
   *
   * Creates the search and the rubric and returns both ids, so onboarding is one
   * call rather than three. Everything created is ordinary data the user can
   * edit or delete afterwards - a playbook is a starting point, not a template
   * the records stay bound to.
   */
  router.post("/playbooks/:slug/start", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = requireContext(req)
      const slug = z.string().min(1).max(64).parse(req.params.slug)
      const body = z.object({ name: z.string().min(1).max(160).optional() }).parse(req.body ?? {})

      const playbook = playbookBySlug(slug)
      if (!playbook) {
        throw new AppError(PROBLEM_TYPES.NOT_FOUND, { detail: `No playbook named "${slug}".` })
      }

      const [search] = await withWorkspace(
        ctx,
        async ({ tx, values }) =>
          tx
            .insert(searches)
            .values(
              values({
                name: body.name ?? playbook.slug,
                targetType: playbook.targetType,
                spec: playbook.spec,
              })
            )
            .returning(),
        options.db
      )

      const [rubric] = await withWorkspace(
        ctx,
        async ({ tx, values }) =>
          tx
            .insert(rubrics)
            .values(
              values({
                name: body.name ?? playbook.slug,
                targetType: playbook.targetType,
                definition: playbook.rubric,
                templateSlug: playbook.slug,
                version: 1,
              })
            )
            .returning(),
        options.db
      )

      res.status(201).json({
        playbook: playbook.slug,
        search_id: search!.id,
        rubric_id: rubric!.id,
        spec: playbook.spec,
        // What to do next, so the client does not have to know the order.
        next: {
          run_search: `/v1/searches/${search!.id}/run`,
          score: `/v1/rubrics/${rubric!.id}/score`,
        },
      })
    } catch (error) {
      next(error)
    }
  })

  /** Encodes a spec as a shareable query string. */
  router.post("/searches/encode", (req: Request, res: Response, next: NextFunction) => {
    try {
      requireContext(req)
      const body = z
        .object({ spec: SearchSpecSchema, opaque: z.boolean().default(false) })
        .parse(req.body ?? {})

      res.json({ query: encodeSearchSpecToQuery(body.spec, { opaque: body.opaque }) })
    } catch (error) {
      next(error)
    }
  })

  return router
}

/**
 * Reads the stored profile back through its schema.
 *
 * A parse rather than a cast: the column is jsonb, and a row written by an older
 * version would otherwise flow into the search builder unvalidated. A profile
 * that no longer parses is treated as absent, because pre-filling a search from
 * a shape nobody checked is worse than asking one question again.
 */
async function loadOnboarding(
  ctx: Parameters<typeof withWorkspace>[0],
  db: Database
): Promise<OnboardingProfile | null> {
  const rows = await withWorkspace(
    ctx,
    async ({ tx }) =>
      tx
        .select({ onboarding: workspaces.onboarding })
        .from(workspaces)
        .where(eq(workspaces.id, ctx.workspaceId))
        .limit(1),
    db
  )

  const raw = rows[0]?.onboarding
  if (raw === null || raw === undefined) return null

  const parsed = OnboardingProfileSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

async function saveOnboarding(
  ctx: Parameters<typeof withWorkspace>[0],
  profile: OnboardingProfile,
  db: Database
): Promise<OnboardingProfile> {
  const validated = OnboardingProfileSchema.parse(profile)

  await withWorkspace(
    ctx,
    async ({ tx }) =>
      tx
        .update(workspaces)
        .set({ onboarding: validated, updatedAt: new Date() })
        .where(eq(workspaces.id, ctx.workspaceId)),
    db
  )

  return validated
}

/** Rebuilds the wizard state from what the client sent. */
function buildState(
  body: {
    description: string
    target_type: "local_business" | "company" | "person" | "list"
    // Already narrowed to the accepted union by AnswerSchema.
    answers: { question_id: string; value: string | string[] | number | boolean | null }[]
  },
  profile?: OnboardingProfile | null
): ClarifyState {
  // The profile seeds the state before the user's own answers, so an explicit
  // answer this time always wins over what onboarding recorded.
  let state = startClarification(body.description, body.target_type, profile)

  for (const answer of body.answers) {
    state = applyAnswer(state, { questionId: answer.question_id, value: answer.value })
  }

  return state
}

function toQuestionResponse(question: ReturnType<typeof nextQuestions>[number]) {
  return {
    id: question.id,
    type: question.type,
    prompt_key: question.promptKey,
    ...(question.options
      ? {
          options: question.options.map((option) => ({
            value: option.value,
            label_key: option.labelKey,
            ...(option.isDefault ? { is_default: true } : {}),
          })),
        }
      : {}),
    ...(question.min !== undefined ? { min: question.min } : {}),
    ...(question.max !== undefined ? { max: question.max } : {}),
    ...(question.unit ? { unit: question.unit } : {}),
    default_value: question.defaultValue,
    reason_key: question.reasonKey,
  }
}
