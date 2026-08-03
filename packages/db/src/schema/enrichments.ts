import {
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
 * One provider's output for one company, versioned and dated.
 *
 * Versioned because a provider's extraction logic changes: when web.techstack
 * learns a new CMS signature, previously stored "cms: null" values were not
 * wrong at the time but are stale now. Keeping provider_version lets the cache
 * invalidate exactly those rows instead of everything.
 *
 * Dated because every signal has a TTL - an Impressum barely changes, a job
 * posting does. fetched_at plus the provider's ttlDays decides whether a value
 * still counts.
 */
export const enrichments = pgTable(
  "enrichments",
  {
    id: idColumn(),
    workspaceId: workspaceIdColumn().references(() => workspaces.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Provider id, e.g. "web.presence". */
    providerId: varchar("provider_id", { length: 64 }).notNull(),
    /** Bumped when extraction logic changes; invalidates cached values. */
    providerVersion: varchar("provider_version", { length: 32 }).notNull(),
    /** Flat map of signal key -> value, as the provider returned it. */
    values: jsonb("values").notNull(),
    /** URL or endpoint the values were derived from. */
    sourceUrl: text("source_url"),
    /** FileStorage id of a screenshot or crawl artifact, once M2's scraper lands. */
    fileId: uuid("file_id"),
    /** Set when the provider ran but could not determine values. */
    error: text("error"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    /** fetched_at + ttlDays; a row past this is refetched. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    ...timestampColumns(),
  },
  (table) => [
    // One current row per company and provider. A new run overwrites rather than
    // appends: the history that matters is in audit_log, not here.
    uniqueIndex("enrichments_company_provider_key").on(table.companyId, table.providerId),
    index("enrichments_workspace_idx").on(table.workspaceId),
    index("enrichments_workspace_provider_idx").on(table.workspaceId, table.providerId),
    index("enrichments_expires_idx").on(table.expiresAt),
  ]
)

/**
 * One execution of the signal layer over a set of companies.
 *
 * Separate from search_runs because enrichment is triggered independently: a user
 * can enrich an existing list without searching again, and the same companies can
 * be enriched repeatedly as rubrics change.
 */
export const enrichmentRuns = pgTable(
  "enrichment_runs",
  {
    id: idColumn(),
    workspaceId: workspaceIdColumn().references(() => workspaces.id, { onDelete: "cascade" }),
    /** queued | running | completed | failed | cancelled */
    status: varchar("status", { length: 16 }).notNull().default("queued"),
    /** Providers the planner selected, in execution order. */
    plan: jsonb("plan"),
    /** Signal keys that triggered the run, for the audit trail. */
    referencedKeys: jsonb("referenced_keys"),

    companiesTotal: integer("companies_total").notNull().default(0),
    companiesDone: integer("companies_done").notNull().default(0),
    /** Values served from cache rather than refetched. */
    cacheHits: integer("cache_hits").notNull().default(0),
    providersRun: integer("providers_run").notNull().default(0),

    errorKey: varchar("error_key", { length: 64 }),
    errorDetail: text("error_detail"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timestampColumns(),
  },
  (table) => [
    index("enrichment_runs_workspace_idx").on(table.workspaceId),
    index("enrichment_runs_workspace_created_idx").on(table.workspaceId, table.createdAt, table.id),
  ]
)
