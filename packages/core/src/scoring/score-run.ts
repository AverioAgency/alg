import { and, eq, inArray } from "drizzle-orm"
import { companies, enrichments, leadScores, withWorkspace, type Database } from "@alg/db"
import { type LeadScore, type Rubric } from "@alg/shared"
import { evaluateRubric } from "./evaluate.js"
import { LlmResponseError, type LlmClient } from "./llm-client.js"
import { runLlmStage } from "./llm-stage.js"

/**
 * Scores a set of companies against a rubric and stores the result.
 *
 * Lives in core rather than in the worker so it is testable without BullMQ, and
 * so the same code can back a synchronous preview later.
 */

export interface ScoreCompaniesOptions {
  workspaceId: string
  rubricId: string
  rubric: Rubric
  rubricVersion: number
  companyIds: readonly string[]
  db: Database
  /** null skips the LLM stage; the score is then rule-only. */
  llmClient?: LlmClient | null
  /** Rescores rows that are already current for this rubric version. */
  force?: boolean
  logger?: {
    info(obj: unknown, msg?: string): void
    warn(obj: unknown, msg?: string): void
    debug(obj: unknown, msg?: string): void
  }
  onProgress?: (event: ScoreProgress) => Promise<void> | void
  signal?: AbortSignal
}

export interface ScoreProgress {
  type: "company_done"
  index: number
  total: number
  companyId: string
  total_score: number
  qualified: boolean
}

export interface ScoreRunResult {
  companiesDone: number
  qualifiedCount: number
  llmCalls: number
  llmInputTokens: number
  llmOutputTokens: number
  skipped: number
  /** Companies whose LLM stage failed. They still carry a rule-only score. */
  llmFailures: { companyId: string; reason: string }[]
}

/** Batched so a 500-lead run does not fire 500 round trips. */
const SIGNAL_BATCH_SIZE = 200

export async function scoreCompanies(options: ScoreCompaniesOptions): Promise<ScoreRunResult> {
  const ctx = { workspaceId: options.workspaceId }
  const result: ScoreRunResult = {
    companiesDone: 0,
    qualifiedCount: 0,
    llmCalls: 0,
    llmInputTokens: 0,
    llmOutputTokens: 0,
    skipped: 0,
    llmFailures: [],
  }

  const ids = [...options.companyIds]
  const alreadyScored = options.force
    ? new Set<string>()
    : await currentlyScored(ctx, options.rubricId, options.rubricVersion, ids, options.db)

  const usesLlm = (options.rubric.llmCriteria ?? []).length > 0 && Boolean(options.llmClient)

  for (let offset = 0; offset < ids.length; offset += SIGNAL_BATCH_SIZE) {
    if (options.signal?.aborted) break

    const batch = ids.slice(offset, offset + SIGNAL_BATCH_SIZE)
    const signalsByCompany = await loadSignalsForCompanies(ctx, batch, options.db)
    const entities = await loadEntities(ctx, batch, options.db)

    for (const [index, companyId] of batch.entries()) {
      if (options.signal?.aborted) break

      if (alreadyScored.has(companyId)) {
        result.skipped++
        continue
      }

      const signals = signalsByCompany.get(companyId) ?? {}
      const entity = entities.get(companyId)
      if (!entity) {
        // The company vanished between enqueueing and scoring. Not an error for
        // the run - just nothing to score.
        result.skipped++
        continue
      }

      let llm: LeadScore["llm"] = null

      if (usesLlm && options.llmClient) {
        try {
          const stage = await runLlmStage({
            client: options.llmClient,
            rubric: options.rubric,
            signals,
            entity,
            ...(options.signal ? { signal: options.signal } : {}),
          })

          if (stage) {
            llm = stage.assessment
            result.llmCalls++
            result.llmInputTokens += stage.usage.inputTokens
            result.llmOutputTokens += stage.usage.outputTokens
          }
        } catch (error) {
          // One lead's failed assessment must not abort the run: a rule-only
          // score is still useful, and llm stays null so the gap is visible.
          const reason = error instanceof Error ? error.message : String(error)
          result.llmFailures.push({ companyId, reason })
          options.logger?.warn({ companyId, err: error }, "LLM stage failed for one company")

          // A malformed answer is this lead's problem; anything else - auth,
          // rate limits, network - will hit every remaining lead too.
          if (!(error instanceof LlmResponseError)) throw error
        }
      }

      const score = evaluateRubric({ signals, rubric: options.rubric, llm })

      await persistScore(ctx, {
        companyId,
        rubricId: options.rubricId,
        rubricVersion: options.rubricVersion,
        score,
        db: options.db,
      })

      result.companiesDone++
      if (score.qualified) result.qualifiedCount++

      await options.onProgress?.({
        type: "company_done",
        index: offset + index,
        total: ids.length,
        companyId,
        total_score: score.total,
        qualified: score.qualified,
      })
    }
  }

  return result
}

/**
 * Loads every company's signals in one query per batch.
 *
 * The naive shape - one loadCompanySignals call per company - turns a 500-lead
 * run into 500 round trips, which dominates the runtime of a rule-only pass.
 */
async function loadSignalsForCompanies(
  ctx: { workspaceId: string },
  companyIds: readonly string[],
  db: Database
): Promise<Map<string, Record<string, unknown>>> {
  const rows = await withWorkspace(
    ctx,
    async ({ tx, scope }) =>
      tx
        .select({
          companyId: enrichments.companyId,
          values: enrichments.values,
        })
        .from(enrichments)
        .where(scope(enrichments, inArray(enrichments.companyId, [...companyIds]))),
    db
  )

  const byCompany = new Map<string, Record<string, unknown>>()

  for (const row of rows) {
    const existing = byCompany.get(row.companyId) ?? {}
    // Providers write disjoint key namespaces, so merging cannot collide - the
    // registry rejects two providers claiming the same signal key.
    Object.assign(existing, asSignalMap(row.values))
    byCompany.set(row.companyId, existing)
  }

  return byCompany
}

async function loadEntities(
  ctx: { workspaceId: string },
  companyIds: readonly string[],
  db: Database
): Promise<Map<string, { name: string; city: string | null; domain: string | null }>> {
  const rows = await withWorkspace(
    ctx,
    async ({ tx, scope }) =>
      tx
        .select({
          id: companies.id,
          name: companies.name,
          city: companies.city,
          domain: companies.domain,
        })
        .from(companies)
        .where(scope(companies, inArray(companies.id, [...companyIds]))),
    db
  )

  return new Map(
    rows.map((row) => [row.id, { name: row.name, city: row.city, domain: row.domain }])
  )
}

/** Ids whose stored score already matches the current rubric version. */
async function currentlyScored(
  ctx: { workspaceId: string },
  rubricId: string,
  rubricVersion: number,
  companyIds: readonly string[],
  db: Database
): Promise<Set<string>> {
  if (companyIds.length === 0) return new Set()

  const rows = await withWorkspace(
    ctx,
    async ({ tx, scope }) =>
      tx
        .select({ companyId: leadScores.companyId })
        .from(leadScores)
        .where(
          scope(
            leadScores,
            and(
              eq(leadScores.rubricId, rubricId),
              eq(leadScores.rubricVersion, rubricVersion),
              inArray(leadScores.companyId, [...companyIds])
            )!
          )
        ),
    db
  )

  return new Set(rows.map((row) => row.companyId))
}

async function persistScore(
  ctx: { workspaceId: string },
  args: {
    companyId: string
    rubricId: string
    rubricVersion: number
    score: LeadScore
    db: Database
  }
): Promise<void> {
  await withWorkspace(
    ctx,
    async ({ tx, values }) =>
      tx
        .insert(leadScores)
        .values(
          values({
            companyId: args.companyId,
            rubricId: args.rubricId,
            rubricVersion: args.rubricVersion,
            total: args.score.total,
            qualified: args.score.qualified,
            threshold: args.score.threshold,
            breakdown: args.score.breakdown,
            llm: args.score.llm ?? null,
            scoredAt: new Date(),
          })
        )
        // Rescoring overwrites, but the user's hand-labelled feedback survives:
        // it is their judgement about the company, not about this score, and it
        // is the input to calibration.
        .onConflictDoUpdate({
          target: [leadScores.companyId, leadScores.rubricId],
          set: {
            rubricVersion: args.rubricVersion,
            total: args.score.total,
            qualified: args.score.qualified,
            threshold: args.score.threshold,
            breakdown: args.score.breakdown,
            llm: args.score.llm ?? null,
            scoredAt: new Date(),
            updatedAt: new Date(),
          },
        }),
    args.db
  )
}

/** jsonb comes back as unknown; anything that is not a plain object is no signal map. */
function asSignalMap(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {}
}
