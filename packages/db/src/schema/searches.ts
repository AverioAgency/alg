import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"
import { idColumn, timestampColumns, workspaceIdColumn } from "./common.js"
import { workspaces } from "./workspaces.js"

/**
 * A saved SearchSpec. Separating the definition from its executions is what makes
 * a monitor possible: the same spec runs on a schedule, and each run is compared
 * against what the previous ones already found.
 */
export const searches = pgTable(
  "searches",
  {
    id: idColumn(),
    workspaceId: workspaceIdColumn().references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    targetType: varchar("target_type", { length: 32 }).notNull(),
    /** The serialized SearchSpec, validated by SearchSpecSchema on write. */
    spec: jsonb("spec").notNull(),
    /** Empty means the planner chooses the adapters. */
    sources: jsonb("sources"),
    /** A monitor re-runs on monitorCron and only reports what is new. */
    isMonitor: boolean("is_monitor").notNull().default(false),
    monitorCron: varchar("monitor_cron", { length: 64 }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    ...timestampColumns(),
  },
  (table) => [
    index("searches_workspace_idx").on(table.workspaceId),
    index("searches_workspace_created_idx").on(table.workspaceId, table.createdAt, table.id),
  ]
)

/**
 * One execution of a search.
 *
 * Holds the progress counters the SSE stream reports and, on failure, the reason.
 * Runs are never deleted with their search: what a run found and cost has to stay
 * auditable even after the definition changes.
 */
export const searchRuns = pgTable(
  "search_runs",
  {
    id: idColumn(),
    workspaceId: workspaceIdColumn().references(() => workspaces.id, { onDelete: "cascade" }),
    searchId: uuid("search_id").references(() => searches.id, { onDelete: "set null" }),
    /** queued | running | completed | failed | cancelled */
    status: varchar("status", { length: 16 }).notNull().default("queued"),
    /** Snapshot of the spec as it was when the run started. */
    spec: jsonb("spec").notNull(),
    /** Adapters the planner selected, with their push-down/post-filter split. */
    plan: jsonb("plan"),

    entitiesFound: integer("entities_found").notNull().default(0),
    entitiesNew: integer("entities_new").notNull().default(0),
    /**
     * Die Firmen, die DIESER Lauf geliefert hat - neue und wiedergefundene.
     *
     * Ohne diese Liste kann niemand "das Ergebnis dieser Suche" bewerten oder
     * anzeigen: `first_seen_run_id` kennt nur die Erstfunde, und ein Autohaus,
     * das schon in der Datenbank stand, gehoert trotzdem zum Ergebnis. Die
     * Bewertung lief deshalb mit all:true ueber den ganzen Workspace, und eine
     * Suche nach Autohaeusern zeigte die Restaurants der Vortage - frisch
     * bewertet, mit 0 Punkten, aber in der Liste.
     */
    companyIds: jsonb("company_ids").$type<string[]>(),
    entitiesDuplicate: integer("entities_duplicate").notNull().default(0),
    /** Actual spend in EUR cents; integer avoids float drift on money. */
    costCents: bigint("cost_cents", { mode: "number" }).notNull().default(0),

    /** i18n key plus detail, so the frontend can render it in German. */
    errorKey: varchar("error_key", { length: 64 }),
    errorDetail: text("error_detail"),

    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timestampColumns(),
  },
  (table) => [
    index("search_runs_workspace_idx").on(table.workspaceId),
    index("search_runs_workspace_search_idx").on(table.workspaceId, table.searchId),
    index("search_runs_workspace_status_idx").on(table.workspaceId, table.status),
    index("search_runs_workspace_created_idx").on(table.workspaceId, table.createdAt, table.id),
  ]
)

/**
 * Append-only progress log per run. The SSE endpoint replays this on reconnect,
 * so a client that drops mid-run does not lose the events it missed.
 */
export const searchRunEvents = pgTable(
  "search_run_events",
  {
    id: idColumn(),
    workspaceId: workspaceIdColumn().references(() => workspaces.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => searchRuns.id, { onDelete: "cascade" }),
    /** Monotonic per run; the SSE Last-Event-ID resumes from it. */
    sequence: integer("sequence").notNull(),
    /** progress | adapter_started | adapter_finished | completed | failed */
    type: varchar("type", { length: 32 }).notNull(),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("search_run_events_run_idx").on(table.runId, table.sequence),
    index("search_run_events_workspace_idx").on(table.workspaceId),
  ]
)
