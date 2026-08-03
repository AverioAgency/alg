import { sql } from "drizzle-orm"
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"
import { idColumn, timestampColumns, workspaceIdColumn } from "./common.js"
import { companies } from "./companies.js"
import { workspaces } from "./workspaces.js"

/**
 * A rubric: the user's definition of what makes a lead worth contacting.
 *
 * The whole point of the system is that this is data. One workspace scores on
 * "has no website", the next on "runs an outdated ERP", and both run through the
 * same evaluator with no code change. Anything hardcoded here would break that.
 */
export const rubrics = pgTable(
  "rubrics",
  {
    id: idColumn(),
    workspaceId: workspaceIdColumn().references(() => workspaces.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 160 }).notNull(),
    description: text("description"),
    /**
     * The whole Rubric contract as one document.
     *
     * jsonb rather than normalized rows: a rubric is edited and versioned as a
     * unit, so splitting it would buy nothing and cost a join on the hottest
     * path in scoring.
     */
    definition: jsonb("definition").notNull(),
    /** A rubric written against local_business signals is invalid for a person search. */
    targetType: varchar("target_type", { length: 24 }).notNull(),
    /** Set when the rubric came from a template, for provenance in the UI. */
    templateSlug: varchar("template_slug", { length: 64 }),
    /**
     * Bumped on every edit. lead_scores records the version it used, so a score
     * computed before an edit is recognizable rather than silently misleading.
     */
    version: integer("version").notNull().default(1),
    /** Soft delete: scores reference the rubric and must stay explainable. */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...timestampColumns(),
  },
  (table) => [
    index("rubrics_workspace_idx").on(table.workspaceId),
    index("rubrics_workspace_created_idx").on(table.workspaceId, table.createdAt, table.id),
    index("rubrics_workspace_target_idx").on(table.workspaceId, table.targetType),
  ]
)

/**
 * One company's score under one rubric.
 *
 * The breakdown is stored, not recomputed on read: the signals behind a score
 * have TTLs and get refetched, so recomputing later would silently produce a
 * different number than the user saw when they acted on it.
 */
export const leadScores = pgTable(
  "lead_scores",
  {
    id: idColumn(),
    workspaceId: workspaceIdColumn().references(() => workspaces.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    rubricId: uuid("rubric_id")
      .notNull()
      .references(() => rubrics.id, { onDelete: "cascade" }),
    /** Without this, a score from before a rubric edit looks current. */
    rubricVersion: integer("rubric_version").notNull(),
    total: integer("total").notNull(),
    qualified: boolean("qualified").notNull().default(false),
    /** Copied from the rubric at scoring time, so the verdict stays reproducible. */
    threshold: integer("threshold").notNull(),
    /** Per-criterion detail. A score without it cannot be explained to the user. */
    breakdown: jsonb("breakdown").notNull(),
    /**
     * The LLM assessment, or null when the stage did not run - no API key, or
     * the rubric has no llmCriteria. null and "the LLM scored it zero" are
     * different findings and must not collapse into one.
     */
    llm: jsonb("llm"),
    /** The user's own verdict. Feeds threshold calibration. */
    feedback: varchar("feedback", { length: 8 }).$type<"good" | "bad" | null>(),
    feedbackAt: timestamp("feedback_at", { withTimezone: true }),
    scoredAt: timestamp("scored_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestampColumns(),
  },
  (table) => [
    uniqueIndex("lead_scores_company_rubric_key").on(table.companyId, table.rubricId),
    index("lead_scores_workspace_idx").on(table.workspaceId),
    // The ranking query: qualified leads for one rubric, best first.
    index("lead_scores_rubric_rank_idx").on(
      table.workspaceId,
      table.rubricId,
      sql`${table.total} DESC`,
      table.id
    ),
  ]
)

/** Progress of one scoring pass, mirrored to SSE the same way discovery is. */
export const scoringRuns = pgTable(
  "scoring_runs",
  {
    id: idColumn(),
    workspaceId: workspaceIdColumn().references(() => workspaces.id, { onDelete: "cascade" }),
    rubricId: uuid("rubric_id")
      .notNull()
      .references(() => rubrics.id, { onDelete: "cascade" }),
    status: varchar("status", { length: 16 })
      .notNull()
      .default("queued")
      .$type<"queued" | "running" | "completed" | "failed" | "cancelled">(),
    companiesTotal: integer("companies_total").notNull().default(0),
    companiesDone: integer("companies_done").notNull().default(0),
    qualifiedCount: integer("qualified_count").notNull().default(0),
    /**
     * Zero with a configured key means every lead was rule-scored - either the
     * rubric has no LLM stage or every call failed. Worth being able to see.
     */
    llmCalls: integer("llm_calls").notNull().default(0),
    llmInputTokens: integer("llm_input_tokens").notNull().default(0),
    llmOutputTokens: integer("llm_output_tokens").notNull().default(0),
    /** Stable slug, so the frontend can branch without parsing German. */
    errorKey: varchar("error_key", { length: 64 }),
    errorDetail: text("error_detail"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timestampColumns(),
  },
  (table) => [
    index("scoring_runs_workspace_idx").on(table.workspaceId),
    index("scoring_runs_workspace_created_idx").on(table.workspaceId, table.createdAt, table.id),
  ]
)

export type RubricRow = typeof rubrics.$inferSelect
export type NewRubricRow = typeof rubrics.$inferInsert
export type LeadScoreRow = typeof leadScores.$inferSelect
export type NewLeadScoreRow = typeof leadScores.$inferInsert
export type ScoringRunRow = typeof scoringRuns.$inferSelect
export type NewScoringRunRow = typeof scoringRuns.$inferInsert
