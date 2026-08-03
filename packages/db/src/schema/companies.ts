import { sql } from "drizzle-orm"
import {
  doublePrecision,
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

export const companies = pgTable(
  "companies",
  {
    id: idColumn(),
    workspaceId: workspaceIdColumn().references(() => workspaces.id, { onDelete: "cascade" }),
    targetType: varchar("target_type", { length: 32 }).notNull(),
    name: text("name").notNull(),
    /** Registrable domain, lowercased, no www - the primary dedupe key after place_id. */
    domain: text("domain"),
    website: text("website"),
    /** E.164 normalized. */
    phone: text("phone"),
    email: text("email"),
    street: text("street"),
    houseNumber: text("house_number"),
    postalCode: varchar("postal_code", { length: 16 }),
    city: text("city"),
    region: text("region"),
    countryCode: varchar("country_code", { length: 2 }),
    lat: doublePrecision("lat"),
    lon: doublePrecision("lon"),
    /** Normalized name used for trigram fuzzy dedupe (lowercased, legal forms stripped). */
    nameNormalized: text("name_normalized"),
    /**
     * Which dedupe stage created or merged this row, and how confident it was.
     * Kept so a wrong merge can be found later - without it, a bad fuzzy match is
     * indistinguishable from a legitimate one.
     */
    dedupeStage: varchar("dedupe_stage", { length: 16 }),
    dedupeConfidence: doublePrecision("dedupe_confidence"),
    /** Set when this row was first seen by a specific run. */
    firstSeenRunId: uuid("first_seen_run_id"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    ...timestampColumns(),
  },
  (table) => [
    index("companies_workspace_idx").on(table.workspaceId),
    index("companies_workspace_target_idx").on(table.workspaceId, table.targetType),
    // Partial unique: a domain identifies a company within a workspace, but many
    // companies legitimately have none.
    uniqueIndex("companies_workspace_domain_key")
      .on(table.workspaceId, table.domain)
      .where(sql`${table.domain} IS NOT NULL`),
    index("companies_workspace_postal_idx").on(table.workspaceId, table.postalCode),
    index("companies_workspace_created_idx").on(table.workspaceId, table.createdAt, table.id),
  ]
)

export const contacts = pgTable(
  "contacts",
  {
    id: idColumn(),
    workspaceId: workspaceIdColumn().references(() => workspaces.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    firstName: text("first_name"),
    lastName: text("last_name"),
    role: text("role"),
    email: text("email"),
    phone: text("phone"),
    linkedinUrl: text("linkedin_url"),
    ...timestampColumns(),
  },
  (table) => [
    index("contacts_workspace_idx").on(table.workspaceId),
    index("contacts_workspace_company_idx").on(table.workspaceId, table.companyId),
    index("contacts_workspace_email_idx").on(table.workspaceId, table.email),
    index("contacts_workspace_created_idx").on(table.workspaceId, table.createdAt, table.id),
  ]
)

/**
 * Provenance: which adapter produced this company, when, and with what payload.
 * Required for the GDPR Art. 14 notice, which must name the source the data came
 * from - so this table is not optional bookkeeping.
 */
export const companySources = pgTable(
  "company_sources",
  {
    id: idColumn(),
    workspaceId: workspaceIdColumn().references(() => workspaces.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Discovery adapter id, e.g. "overpass", "google_places", "csv". */
    sourceId: varchar("source_id", { length: 64 }).notNull(),
    /** Stable id within that source (place_id, OSM id, WKO number). */
    externalId: text("external_id"),
    sourceUrl: text("source_url"),
    /** Untouched adapter payload, so we can re-normalize without re-fetching. */
    rawPayload: jsonb("raw_payload"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestampColumns(),
  },
  (table) => [
    index("company_sources_workspace_idx").on(table.workspaceId),
    index("company_sources_company_idx").on(table.workspaceId, table.companyId),
    uniqueIndex("company_sources_workspace_source_external_key").on(
      table.workspaceId,
      table.sourceId,
      table.externalId
    ),
  ]
)
