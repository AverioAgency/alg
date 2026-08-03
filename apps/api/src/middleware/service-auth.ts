import { createHash, timingSafeEqual } from "node:crypto"
import { type NextFunction, type Request, type Response } from "express"
import { and, eq } from "drizzle-orm"
import { users, workspaceMembers, workspaces, withoutWorkspaceScope, type Database } from "@alg/db"
import {
  AppError,
  PROBLEM_TYPES,
  isValidWorkspaceSlug,
  tenantSlugFromHost,
  type WorkspaceRole,
} from "@alg/shared"

/**
 * The trusted-service path: how the Nexoro PHP backend calls ALG.
 *
 * Nexoro authenticates its own users. Rather than issuing every one of them a
 * Supabase login they would never see, its server presents a shared secret and
 * states which tenant and which of its users is acting. ALG trusts that, mirrors
 * the user locally so the audit trail names a person rather than "the service",
 * and resolves the workspace from the request's hostname.
 *
 * This is only sound because the caller is a server we operate. Two properties
 * hold it up, and both are enforced here rather than assumed:
 *
 *   - The secret never reaches a browser. It is compared in constant time, and
 *     the whole path is disabled when ALG_SERVICE_TOKEN is unset - there is no
 *     weaker fallback.
 *   - A hostname alone never grants access. The subdomain only *names* a
 *     workspace; presenting the secret is what authorises using it. Without the
 *     secret the host header is ignored completely.
 *
 * Everything downstream is unchanged: req.ctx looks exactly as it does after a
 * Supabase login, and withWorkspace() still enforces the scope.
 */

export const SERVICE_TOKEN_HEADER = "x-alg-service-token"
export const ACTING_USER_HEADER = "x-alg-user"
export const ACTING_USER_EMAIL_HEADER = "x-alg-user-email"
export const WORKSPACE_SLUG_HEADER = "x-workspace-slug"

export interface ServiceAuthOptions {
  db: Database
  /** ALG_SERVICE_TOKEN. Undefined disables this path entirely. */
  serviceToken?: string | undefined
  /** ALG_TENANT_DOMAIN, e.g. "nexoro.net". Empty disables host-based resolution. */
  tenantDomain: string
  /**
   * Creates a workspace the first time its subdomain appears.
   *
   * The user asked for this explicitly. It is convenient and it is also why the
   * reserved-slug list and the strict hostname parsing in @alg/shared matter: a
   * typo would otherwise create an empty workspace that looks like data loss,
   * and every unknown host would write a row.
   */
  autoProvision: boolean
}

/**
 * A stable uuid for an external user id.
 *
 * The users table keys on the Supabase auth id, so an external identifier needs
 * a uuid. Derived by hashing rather than generated, so the same Nexoro user maps
 * to the same row on every request without a lookup table - and so the mapping
 * survives a database restore. Namespaced per workspace: two tenants using the
 * same internal id (`1`, `admin`) must not collide into one ALG user.
 */
export function deriveUserId(workspaceSlug: string, externalId: string): string {
  const digest = createHash("sha256").update(`alg:user:${workspaceSlug}:${externalId}`).digest()
  const bytes = Buffer.from(digest.subarray(0, 16))

  // Stamp version 4 and the RFC 4122 variant so the value is a well-formed uuid
  // rather than 16 random-looking bytes that some client library rejects.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80

  const hex = bytes.toString("hex")
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-")
}

/** Constant-time comparison, so a wrong token cannot be found byte by byte. */
function secretMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  // timingSafeEqual throws on differing lengths, which would itself leak the
  // length - hash both sides to a fixed width first.
  const ha = createHash("sha256").update(a).digest()
  const hb = createHash("sha256").update(b).digest()
  return timingSafeEqual(ha, hb)
}

export function createServiceAuthMiddleware(options: ServiceAuthOptions) {
  const enabled = Boolean(options.serviceToken)

  return async function serviceAuth(
    req: Request,
    _res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const presented = req.header(SERVICE_TOKEN_HEADER)

      // No token: fall through to the Supabase path. Not an error - both ways in
      // are legitimate, and the next middleware decides.
      if (!presented) {
        next()
        return
      }

      if (!enabled) {
        throw new AppError(PROBLEM_TYPES.UNAUTHENTICATED, {
          detail: "Service authentication is not configured on this deployment.",
        })
      }

      if (!secretMatches(presented, options.serviceToken ?? "")) {
        throw new AppError(PROBLEM_TYPES.UNAUTHENTICATED, {
          detail: "Invalid service token.",
        })
      }

      const slug = resolveSlug(req, options.tenantDomain)
      const workspaceId = await resolveWorkspace(options, slug)

      // Which of Nexoro's users is acting. Optional, but without it the audit
      // log records a service rather than a person - so the fallback is named
      // explicitly rather than left blank.
      const externalUser = req.header(ACTING_USER_HEADER)?.trim() || "service"
      const email = req.header(ACTING_USER_EMAIL_HEADER)?.trim() || null
      const userId = deriveUserId(slug, externalUser)

      const role = await ensureMembership(options.db, {
        workspaceId,
        userId,
        email: email ?? `${externalUser}@${slug}.service.local`,
        displayName: externalUser,
      })

      req.ctx = {
        userId,
        workspaceId,
        role,
        email,
        requestId: req.header("x-request-id") ?? crypto.randomUUID(),
      }

      next()
    } catch (error) {
      next(error)
    }
  }
}

/**
 * Which workspace this request is for.
 *
 * The hostname is the intended source. An explicit x-workspace-slug header wins
 * when present, because the PHP backend may act for a tenant other than the one
 * whose domain it was reached on - and it has already proven it holds the
 * service token, so it is allowed to say so.
 */
function resolveSlug(req: Request, tenantDomain: string): string {
  const explicit = req.header(WORKSPACE_SLUG_HEADER)?.trim().toLowerCase()
  if (explicit) {
    if (!isValidWorkspaceSlug(explicit)) {
      throw new AppError(PROBLEM_TYPES.WORKSPACE_REQUIRED, {
        detail: `"${explicit}" is not a usable workspace slug.`,
      })
    }
    return explicit
  }

  // X-Forwarded-Host is what Traefik sets; req.hostname follows it because the
  // app runs with trust proxy enabled.
  const host = req.header("x-forwarded-host") ?? req.header("host")
  const result = tenantSlugFromHost(host, tenantDomain)

  if (!result.slug) {
    throw new AppError(PROBLEM_TYPES.WORKSPACE_REQUIRED, {
      detail:
        `Could not derive a workspace from the hostname (${result.reason ?? "unknown"}). ` +
        `Send ${WORKSPACE_SLUG_HEADER} instead.`,
    })
  }

  return result.slug
}

async function resolveWorkspace(options: ServiceAuthOptions, slug: string): Promise<string> {
  const existing = await withoutWorkspaceScope(
    "Resolving which workspace a request belongs to cannot itself be workspace-scoped.",
    async (db) =>
      db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.slug, slug)).limit(1),
    options.db
  )

  const found = existing[0]
  if (found) return found.id

  if (!options.autoProvision) {
    throw new AppError(PROBLEM_TYPES.NOT_FOUND, {
      detail: `No workspace "${slug}", and automatic creation is disabled.`,
    })
  }

  const created = await withoutWorkspaceScope(
    "Creating a workspace happens before any workspace scope exists.",
    async (db) =>
      db
        .insert(workspaces)
        .values({ name: slug, slug })
        // Two concurrent first requests for the same new tenant would otherwise
        // race into a unique violation; the second one reads the winner's row.
        .onConflictDoNothing({ target: workspaces.slug })
        .returning({ id: workspaces.id }),
    options.db
  )

  if (created[0]) return created[0].id

  const afterRace = await withoutWorkspaceScope(
    "Re-reading after a concurrent insert, still before any scope exists.",
    async (db) =>
      db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.slug, slug)).limit(1),
    options.db
  )

  const winner = afterRace[0]
  if (!winner) {
    throw new AppError(PROBLEM_TYPES.INTERNAL, {
      detail: `Workspace "${slug}" could neither be created nor read.`,
    })
  }
  return winner.id
}

/**
 * Mirrors the acting user and their membership, creating both on first sight.
 *
 * The role is `member`: enough to search, enrich and score, not enough to do
 * anything a service acting on someone's behalf should not do unattended.
 */
async function ensureMembership(
  db: Database,
  args: { workspaceId: string; userId: string; email: string; displayName: string }
): Promise<WorkspaceRole> {
  const existing = await withoutWorkspaceScope(
    "Membership lookup establishes the workspace scope; it cannot be scoped by it.",
    async (database) =>
      database
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, args.workspaceId),
            eq(workspaceMembers.userId, args.userId)
          )
        )
        .limit(1),
    db
  )

  const found = existing[0]
  if (found) {
    const role = found.role
    return role === "owner" || role === "admin" || role === "viewer" ? role : "member"
  }

  await withoutWorkspaceScope(
    "Mirroring an external user is a global write, before any scope applies.",
    async (database) =>
      database
        .insert(users)
        .values({ id: args.userId, email: args.email, displayName: args.displayName })
        .onConflictDoNothing({ target: users.id }),
    db
  )

  await withoutWorkspaceScope(
    "Granting the mirrored user access to the workspace it acts in.",
    async (database) =>
      database
        .insert(workspaceMembers)
        .values({ workspaceId: args.workspaceId, userId: args.userId, role: "member" })
        .onConflictDoNothing({
          target: [workspaceMembers.workspaceId, workspaceMembers.userId],
        }),
    db
  )

  return "member"
}
