import { type NextFunction, type Request, type Response } from "express"
import { jwtVerify } from "jose"
import { and, eq } from "drizzle-orm"
import { workspaceMembers, withoutWorkspaceScope, type Database } from "@alg/db"
import {
  AppError,
  PROBLEM_TYPES,
  WorkspaceRoleSchema,
  type RequestContext,
  type WorkspaceRole,
} from "@alg/shared"

/**
 * Authentication and workspace resolution.
 *
 * Supabase issues the JWT; we only verify it. This project uses the symmetric
 * legacy scheme (HS256 with SUPABASE_JWT_SECRET). If the Supabase project is ever
 * migrated to asymmetric signing keys, this is the one place that has to change -
 * swap jwtVerify's key argument for a remote JWKS set.
 *
 * Authorization is entirely ours: there is no RLS, so membership in the requested
 * workspace is checked here on every request and the result is what withWorkspace()
 * later trusts.
 */

// req.ctx is declared in src/types/express.d.ts so every module sees it.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const WORKSPACE_HEADER = "x-workspace-id"

export interface AuthMiddlewareOptions {
  jwtSecret: string
  db: Database
  /** Supabase sets `iss` to <SUPABASE_URL>/auth/v1. */
  issuer?: string
}

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization
  if (!header?.startsWith("Bearer ")) return null
  const token = header.slice("Bearer ".length).trim()
  return token.length > 0 ? token : null
}

export function createAuthMiddleware(options: AuthMiddlewareOptions) {
  const key = new TextEncoder().encode(options.jwtSecret)

  return async function authenticate(
    req: Request,
    _res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const token = bearerToken(req)
      if (!token) {
        throw new AppError(PROBLEM_TYPES.UNAUTHENTICATED, {
          detail: "Missing bearer token.",
        })
      }

      let userId: string
      let email: string | null = null
      try {
        const { payload } = await jwtVerify(token, key, {
          algorithms: ["HS256"],
          ...(options.issuer ? { issuer: options.issuer } : {}),
        })

        if (typeof payload.sub !== "string" || !UUID_RE.test(payload.sub)) {
          throw new AppError(PROBLEM_TYPES.UNAUTHENTICATED, {
            detail: "Token subject is not a user id.",
          })
        }
        userId = payload.sub
        if (typeof payload.email === "string") email = payload.email
      } catch (error) {
        if (error instanceof AppError) throw error
        // Do not surface the underlying reason: it distinguishes expired from
        // forged tokens, which is information an attacker does not need.
        throw new AppError(PROBLEM_TYPES.UNAUTHENTICATED, {
          detail: "Token is invalid or expired.",
          cause: error,
        })
      }

      const rawWorkspaceId = req.header(WORKSPACE_HEADER)
      if (!rawWorkspaceId) {
        throw new AppError(PROBLEM_TYPES.WORKSPACE_REQUIRED, {
          detail: `Missing ${WORKSPACE_HEADER} header.`,
        })
      }
      if (!UUID_RE.test(rawWorkspaceId)) {
        throw new AppError(PROBLEM_TYPES.WORKSPACE_REQUIRED, {
          detail: `${WORKSPACE_HEADER} is not a uuid.`,
        })
      }

      const role = await resolveMembership(options.db, rawWorkspaceId, userId)
      if (!role) {
        // Deliberately 403 and not 404: the client knows the id it sent, and
        // distinguishing "no such workspace" from "not a member" leaks existence.
        throw new AppError(PROBLEM_TYPES.FORBIDDEN, {
          detail: "No membership in the requested workspace.",
        })
      }

      req.ctx = {
        userId,
        workspaceId: rawWorkspaceId,
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

async function resolveMembership(
  db: Database,
  workspaceId: string,
  userId: string
): Promise<WorkspaceRole | null> {
  const [row] = await withoutWorkspaceScope(
    "Membership lookup is what establishes the workspace scope; it cannot itself be scoped by it.",
    async (database) =>
      database
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(
          and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId))
        )
        .limit(1),
    db
  )

  if (!row) return null

  const parsed = WorkspaceRoleSchema.safeParse(row.role)
  return parsed.success ? parsed.data : null
}

/** Route guard for endpoints that need more than the default member role. */
export function requireRole(...allowed: WorkspaceRole[]) {
  return function check(req: Request, _res: Response, next: NextFunction): void {
    if (!req.ctx) {
      next(new AppError(PROBLEM_TYPES.UNAUTHENTICATED))
      return
    }
    if (!allowed.includes(req.ctx.role)) {
      next(new AppError(PROBLEM_TYPES.FORBIDDEN, { detail: "Insufficient role." }))
      return
    }
    next()
  }
}

/** Narrowing helper for handlers that run behind the auth middleware. */
export function requireContext(req: Request): RequestContext {
  if (!req.ctx) {
    throw new AppError(PROBLEM_TYPES.UNAUTHENTICATED)
  }
  return req.ctx
}
