import { index, pgTable, text, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core"
import { idColumn, timestampColumns } from "./common.js"

export const workspaces = pgTable(
  "workspaces",
  {
    id: idColumn(),
    name: text("name").notNull(),
    slug: varchar("slug", { length: 64 }).notNull(),
    ...timestampColumns(),
  },
  (table) => [uniqueIndex("workspaces_slug_key").on(table.slug)]
)

/**
 * Mirrors the Supabase auth user. We do not own authentication - Supabase issues
 * the JWT - but we need a local row to hang workspace membership off.
 */
export const users = pgTable(
  "users",
  {
    /** Same uuid as the Supabase auth.users id (the JWT `sub`). */
    id: uuid("id").primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name"),
    ...timestampColumns(),
  },
  (table) => [uniqueIndex("users_email_key").on(table.email)]
)

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: idColumn(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** owner | admin | member | viewer - see WorkspaceRoleSchema in @alg/shared. */
    role: varchar("role", { length: 16 }).notNull().default("member"),
    ...timestampColumns(),
  },
  (table) => [
    uniqueIndex("workspace_members_workspace_user_key").on(table.workspaceId, table.userId),
    index("workspace_members_user_idx").on(table.userId),
  ]
)
