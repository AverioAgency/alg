import { bigint, index, pgTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core"
import { idColumn, timestampColumns, workspaceIdColumn } from "./common.js"
import { workspaces } from "./workspaces.js"

/**
 * The authoritative record for every artifact on disk. The on-disk path is derived
 * exclusively from these columns - never from request input - which is what makes
 * path traversal structurally impossible rather than merely filtered.
 */
export const files = pgTable(
  "files",
  {
    id: idColumn(),
    workspaceId: workspaceIdColumn().references(() => workspaces.id, { onDelete: "cascade" }),
    /** screenshot | report | export | crawl */
    kind: varchar("kind", { length: 32 }).notNull(),
    /** Relative to ALG_STORAGE_PATH: {workspace}/{kind}/{yyyy}/{mm}/{id}.{ext} */
    relativePath: text("relative_path").notNull(),
    mime: varchar("mime", { length: 128 }).notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    /** sha256 hex. */
    checksum: varchar("checksum", { length: 64 }).notNull(),
    /** Null means keep indefinitely; the cleanup cron ignores those rows. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    ...timestampColumns(),
  },
  (table) => [
    index("files_workspace_idx").on(table.workspaceId),
    index("files_workspace_kind_idx").on(table.workspaceId, table.kind),
    index("files_expires_idx").on(table.expiresAt),
    uniqueIndex("files_relative_path_key").on(table.relativePath),
  ]
)
