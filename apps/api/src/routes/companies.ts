import { Router, type NextFunction, type Request, type Response } from "express"
import { asc, desc, eq, sql, type SQL } from "drizzle-orm"
import { z } from "zod"
import { companies, companySources, contacts, withWorkspace, type Database } from "@alg/db"
import { AppError, PROBLEM_TYPES, decodeCursor, encodeCursor } from "@alg/shared"
import { requireContext } from "../middleware/auth.js"

/**
 * Read endpoints for the entities discovery produced.
 *
 * Keyset pagination throughout: an offset shifts while a discovery run is
 * inserting rows, so a client paging through results would see duplicates and
 * skip others. The cursor encodes (created_at, id), which is unique and stable.
 */

const ListQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Substring match on the name. */
  q: z.string().min(1).max(200).optional(),
  city: z.string().min(1).max(120).optional(),
  postal_code: z.string().min(1).max(16).optional(),
  country: z.string().length(2).optional(),
  target_type: z.enum(["local_business", "company", "person", "list"]).optional(),
  has_website: z.enum(["true", "false"]).optional(),
  /**
   * Nur die Firmen, die dieser Suchlauf zuerst gefunden hat.
   *
   * Ohne diesen Filter kann ein Client nicht zeigen, was *diese* Suche
   * ergeben hat - er sieht nur den ganzen Workspace. Eine Suche nach
   * "Baufirmen in Linz" lieferte dann eine Liste voller Restaurants aus
   * frueheren Laeufen, und es sah aus, als haette die Suche versagt.
   *
   * `first_seen_run_id`, nicht "zuletzt gesehen": eine Firma, die schon
   * bekannt war, ist kein neuer Treffer dieses Laufs - sie taucht in der
   * Historie ohnehin auf.
   */
  run_id: z.uuid().optional(),
  order: z.enum(["created_asc", "created_desc"]).default("created_desc"),
})

const IdParamSchema = z.object({ id: z.uuid() })

export interface CompaniesRouterOptions {
  db: Database
}

export function createCompaniesRouter(options: CompaniesRouterOptions): Router {
  const router = Router()

  router.get("/companies", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = requireContext(req)
      const query = ListQuerySchema.parse(req.query)

      const filters: SQL[] = []
      if (query.q) {
        filters.push(sql`${companies.name} ilike ${"%" + query.q + "%"}`)
      }
      if (query.city) filters.push(eq(companies.city, query.city))
      if (query.postal_code) filters.push(eq(companies.postalCode, query.postal_code))
      if (query.country) filters.push(eq(companies.countryCode, query.country.toUpperCase()))
      if (query.target_type) filters.push(eq(companies.targetType, query.target_type))
      if (query.has_website === "true") filters.push(sql`${companies.domain} is not null`)
      if (query.has_website === "false") filters.push(sql`${companies.domain} is null`)
      if (query.run_id) filters.push(eq(companies.firstSeenRunId, query.run_id))

      const keyset = query.cursor ? parseCursor(query.cursor) : null
      if (query.cursor && !keyset) {
        throw new AppError(PROBLEM_TYPES.VALIDATION_FAILED, { detail: "Invalid cursor." })
      }

      const ascending = query.order === "created_asc"
      if (keyset) {
        // Row-value comparison on (created_at, id): created_at alone is not
        // unique, and ties would silently drop rows between pages.
        const boundary = new Date(keyset.createdAt)
        filters.push(
          ascending
            ? sql`(${companies.createdAt}, ${companies.id}) > (${boundary}, ${keyset.id})`
            : sql`(${companies.createdAt}, ${companies.id}) < (${boundary}, ${keyset.id})`
        )
      }

      // One extra row tells us whether a further page exists without a count query.
      const rows = await withWorkspace(
        ctx,
        async ({ tx, scope }) =>
          tx
            .select()
            .from(companies)
            .where(scope(companies, ...filters))
            .orderBy(
              ascending ? asc(companies.createdAt) : desc(companies.createdAt),
              ascending ? asc(companies.id) : desc(companies.id)
            )
            .limit(query.limit + 1),
        options.db
      )

      const hasMore = rows.length > query.limit
      const page = hasMore ? rows.slice(0, query.limit) : rows
      const last = page.at(-1)

      res.json({
        data: page.map(toCompanyResponse),
        nextCursor:
          hasMore && last
            ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
            : null,
      })
    } catch (error) {
      next(error)
    }
  })

  router.get("/companies/:id", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = requireContext(req)
      const { id } = IdParamSchema.parse(req.params)

      const [company] = await withWorkspace(
        ctx,
        async ({ tx, scope }) =>
          tx
            .select()
            .from(companies)
            .where(scope(companies, eq(companies.id, id)))
            .limit(1),
        options.db
      )

      if (!company) {
        throw new AppError(PROBLEM_TYPES.NOT_FOUND, { detail: "Company not found." })
      }

      // Provenance is part of the record, not an extra: the Art. 14 notice has to
      // name where the data came from.
      const sources = await withWorkspace(
        ctx,
        async ({ tx, scope }) =>
          tx
            .select({
              sourceId: companySources.sourceId,
              externalId: companySources.externalId,
              sourceUrl: companySources.sourceUrl,
              fetchedAt: companySources.fetchedAt,
            })
            .from(companySources)
            .where(scope(companySources, eq(companySources.companyId, id))),
        options.db
      )

      res.json({
        ...toCompanyResponse(company),
        sources: sources.map((s) => ({
          source_id: s.sourceId,
          external_id: s.externalId,
          source_url: s.sourceUrl,
          fetched_at: s.fetchedAt.toISOString(),
        })),
      })
    } catch (error) {
      next(error)
    }
  })

  router.get("/companies/:id/contacts", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = requireContext(req)
      const { id } = IdParamSchema.parse(req.params)

      const rows = await withWorkspace(
        ctx,
        async ({ tx, scope }) =>
          tx
            .select()
            .from(contacts)
            .where(scope(contacts, eq(contacts.companyId, id)))
            .orderBy(asc(contacts.createdAt), asc(contacts.id))
            .limit(200),
        options.db
      )

      res.json({ data: rows.map(toContactResponse), nextCursor: null })
    } catch (error) {
      next(error)
    }
  })

  router.get("/contacts", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = requireContext(req)
      const query = ListQuerySchema.parse(req.query)

      const filters: SQL[] = []
      if (query.q) {
        const term = `%${query.q}%`
        // One fragment rather than or(): or() is typed as possibly-undefined for
        // the empty-argument case, which cannot happen here.
        filters.push(
          sql`(${contacts.firstName} ilike ${term} or ${contacts.lastName} ilike ${term} or ${contacts.email} ilike ${term})`
        )
      }

      const keyset = query.cursor ? parseCursor(query.cursor) : null
      if (query.cursor && !keyset) {
        throw new AppError(PROBLEM_TYPES.VALIDATION_FAILED, { detail: "Invalid cursor." })
      }
      if (keyset) {
        filters.push(
          sql`(${contacts.createdAt}, ${contacts.id}) < (${new Date(keyset.createdAt)}, ${keyset.id})`
        )
      }

      const rows = await withWorkspace(
        ctx,
        async ({ tx, scope }) =>
          tx
            .select()
            .from(contacts)
            .where(scope(contacts, ...filters))
            .orderBy(desc(contacts.createdAt), desc(contacts.id))
            .limit(query.limit + 1),
        options.db
      )

      const hasMore = rows.length > query.limit
      const page = hasMore ? rows.slice(0, query.limit) : rows
      const last = page.at(-1)

      res.json({
        data: page.map(toContactResponse),
        nextCursor:
          hasMore && last
            ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
            : null,
      })
    } catch (error) {
      next(error)
    }
  })

  return router
}

function parseCursor(cursor: string): { createdAt: string; id: string } | null {
  const decoded = decodeCursor(cursor)
  if (!decoded) return null
  const { createdAt, id } = decoded
  if (typeof createdAt !== "string" || typeof id !== "string") return null
  if (Number.isNaN(Date.parse(createdAt))) return null
  return { createdAt, id }
}

/** snake_case on the wire: the frontend contract, not our column names. */
function toCompanyResponse(row: typeof companies.$inferSelect) {
  return {
    id: row.id,
    target_type: row.targetType,
    name: row.name,
    domain: row.domain,
    website: row.website,
    phone: row.phone,
    email: row.email,
    address: {
      street: row.street,
      house_number: row.houseNumber,
      postal_code: row.postalCode,
      city: row.city,
      region: row.region,
      country: row.countryCode,
    },
    geo: row.lat !== null && row.lon !== null ? { lat: row.lat, lon: row.lon } : null,
    dedupe: row.dedupeStage ? { stage: row.dedupeStage, confidence: row.dedupeConfidence } : null,
    last_seen_at: row.lastSeenAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  }
}

function toContactResponse(row: typeof contacts.$inferSelect) {
  return {
    id: row.id,
    company_id: row.companyId,
    first_name: row.firstName,
    last_name: row.lastName,
    role: row.role,
    email: row.email,
    phone: row.phone,
    linkedin_url: row.linkedinUrl,
    created_at: row.createdAt.toISOString(),
  }
}
