import { and, eq, type SQL } from "drizzle-orm"
import { type PgColumn, type PgTable } from "drizzle-orm/pg-core"
import { getDb, type Database } from "./client.js"

/**
 * ALG deliberately runs without RLS: Supabase is used as a plain Postgres and the
 * frontend never talks to it directly. That makes this module the single place
 * where tenant isolation is enforced. Every query must go through it.
 *
 * The guard does three things:
 *   1. Hands the callback a scoped handle whose `where()` helper always ANDs in
 *      workspace_id.
 *   2. Refuses to run without a workspace id, so a missing context fails loudly
 *      instead of silently querying across tenants.
 *   3. Gives the ESLint rule a lexical marker to check for (alg/no-raw-drizzle-query).
 */

export interface WorkspaceContext {
  workspaceId: string
  userId?: string
}

export class MissingWorkspaceError extends Error {
  constructor() {
    super(
      "withWorkspace() called without a workspaceId. Every ALG query must be workspace-scoped - there is no RLS fallback."
    )
    this.name = "MissingWorkspaceError"
  }
}

export class WorkspaceScopeViolationError extends Error {
  constructor(tableName: string) {
    super(
      `Table "${tableName}" has no workspace_id column and cannot be scoped. Use withoutWorkspaceScope() with an explicit justification if this is intentional.`
    )
    this.name = "WorkspaceScopeViolationError"
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The handle passed to a withWorkspace callback. `tx` is the raw Drizzle database;
 * `scope()` builds the workspace predicate for a table, optionally ANDed with more
 * conditions.
 */
export interface WorkspaceScope {
  readonly workspaceId: string
  readonly tx: Database
  /**
   * Returns `workspace_id = $ctx AND ...extra`. Always use this in the where()
   * clause of a query rather than writing the equality by hand.
   */
  scope(table: PgTable, ...extra: (SQL | undefined)[]): SQL
  /** Values to spread into an insert so workspace_id is never forgotten. */
  values<T extends Record<string, unknown>>(input: T): T & { workspaceId: string }
}

function workspaceColumn(table: PgTable): PgColumn {
  // Drizzle exposes columns as properties on the table object but does not type
  // that index access, so reading a column by name needs assertions. workspace_id
  // is a hard convention in this schema; a table without it cannot be scoped.
  // eslint-disable-next-line no-restricted-syntax -- drizzle does not type dynamic column access
  const column = (table as unknown as Record<string, unknown>)["workspaceId"]
  if (!column) {
    const name = (table as unknown as { _: { name: string } })._?.name ?? "unknown"
    throw new WorkspaceScopeViolationError(name)
  }
  // eslint-disable-next-line no-restricted-syntax -- presence checked immediately above
  return column as PgColumn
}

/**
 * Runs `fn` with a workspace-scoped database handle.
 *
 * @example
 * const rows = await withWorkspace(ctx, ({ tx, scope }) =>
 *   tx.select().from(companies).where(scope(companies, eq(companies.domain, d)))
 * )
 */
export async function withWorkspace<T>(
  ctx: WorkspaceContext,
  fn: (scope: WorkspaceScope) => Promise<T>,
  db: Database = getDb()
): Promise<T> {
  if (!ctx?.workspaceId || !UUID_RE.test(ctx.workspaceId)) {
    throw new MissingWorkspaceError()
  }

  const workspaceId = ctx.workspaceId

  const scope: WorkspaceScope = {
    workspaceId,
    tx: db,
    scope(table, ...extra) {
      const conditions = [eq(workspaceColumn(table), workspaceId), ...extra.filter(Boolean)]
      // and() is typed as possibly-undefined for the empty-list case; the workspace
      // predicate guarantees at least one condition here.
      // eslint-disable-next-line no-restricted-syntax -- and() never returns undefined for a non-empty list
      return and(...conditions) as SQL
    },
    values(input) {
      return { ...input, workspaceId }
    },
  }

  return fn(scope)
}

/**
 * Escape hatch for the handful of genuinely global tables (workspaces itself, the
 * RTR/ECG suppression list, cron bookkeeping). Requires a written reason so these
 * stay visible in review and greppable.
 */
export async function withoutWorkspaceScope<T>(
  reason: string,
  fn: (db: Database) => Promise<T>,
  db: Database = getDb()
): Promise<T> {
  if (!reason || reason.trim().length < 10) {
    throw new Error("withoutWorkspaceScope() requires a substantive reason for the audit trail.")
  }
  return fn(db)
}
