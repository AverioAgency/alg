import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"
import { idColumn, timestampColumns, workspaceIdColumn } from "./common.js"
import { workspaces } from "./workspaces.js"

/**
 * Append-only. Everything that deletes data or sends a message lands here.
 * No PII in `metadata` - store ids, not names or addresses.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: idColumn(),
    workspaceId: workspaceIdColumn().references(() => workspaces.id, { onDelete: "cascade" }),
    /** Null for system-initiated actions (cron, worker). */
    actorUserId: uuid("actor_user_id"),
    /** Dotted verb, e.g. "file.delete", "message.send", "company.purge". */
    action: varchar("action", { length: 64 }).notNull(),
    resourceType: varchar("resource_type", { length: 64 }).notNull(),
    resourceId: uuid("resource_id"),
    metadata: jsonb("metadata"),
    ipAddress: text("ip_address"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_log_workspace_idx").on(table.workspaceId),
    index("audit_log_workspace_created_idx").on(table.workspaceId, table.createdAt),
    index("audit_log_workspace_action_idx").on(table.workspaceId, table.action),
  ]
)

/**
 * Backs the Idempotency-Key header on mutating endpoints. The stored response is
 * replayed verbatim when the same key arrives again with the same request body;
 * a different body under the same key is a 409.
 */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: idColumn(),
    workspaceId: workspaceIdColumn().references(() => workspaces.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 255 }).notNull(),
    /** sha256 of method + path + body, to detect key reuse with different payloads. */
    requestFingerprint: varchar("request_fingerprint", { length: 64 }).notNull(),
    responseStatus: jsonb("response_status"),
    responseBody: jsonb("response_body"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestampColumns(),
  },
  (table) => [
    uniqueIndex("idempotency_keys_workspace_key_key").on(table.workspaceId, table.key),
    index("idempotency_keys_expires_idx").on(table.expiresAt),
  ]
)
