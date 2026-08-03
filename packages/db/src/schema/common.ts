import { sql } from "drizzle-orm"
import { timestamp, uuid } from "drizzle-orm/pg-core"

/**
 * Columns every ALG table carries. workspace_id is not nullable anywhere except
 * the workspaces table itself - tenant isolation is enforced in the application
 * layer (there is no RLS), so the column must always be there to filter on.
 */
export const idColumn = () =>
  uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`)

export const timestampColumns = () => ({
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

export const workspaceIdColumn = () => uuid("workspace_id").notNull()
