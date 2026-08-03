import { createHash } from "node:crypto"
import { type NextFunction, type Request, type Response } from "express"
import { eq } from "drizzle-orm"
import { idempotencyKeys, withWorkspace, type Database } from "@alg/db"
import { AppError, PROBLEM_TYPES } from "@alg/shared"

/**
 * Idempotency-Key support for mutating endpoints.
 *
 * Replays the stored response when the same key arrives with an identical request,
 * and rejects with 409 when the same key arrives with a different body - that
 * combination almost always means a client bug, and silently serving the old
 * response would hide it.
 */

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"])
const RETENTION_HOURS = 24

export interface IdempotencyOptions {
  db: Database
}

function fingerprint(req: Request): string {
  const body = req.body === undefined ? "" : JSON.stringify(req.body)
  return createHash("sha256").update(`${req.method}:${req.path}:${body}`).digest("hex")
}

export function createIdempotencyMiddleware(options: IdempotencyOptions) {
  return async function idempotency(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const key = req.header("idempotency-key")
    if (!key || !MUTATING_METHODS.has(req.method) || !req.ctx) {
      next()
      return
    }

    if (key.length > 255) {
      next(
        new AppError(PROBLEM_TYPES.VALIDATION_FAILED, {
          detail: "Idempotency-Key must not exceed 255 characters.",
        })
      )
      return
    }

    const ctx = req.ctx
    const requestFingerprint = fingerprint(req)

    try {
      const [existing] = await withWorkspace(
        ctx,
        async ({ tx, scope }) =>
          tx
            .select()
            .from(idempotencyKeys)
            .where(scope(idempotencyKeys, eq(idempotencyKeys.key, key)))
            .limit(1),
        options.db
      )

      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) {
          next(
            new AppError(PROBLEM_TYPES.IDEMPOTENCY_KEY_REUSED, {
              detail: "This Idempotency-Key was already used with a different request body.",
            })
          )
          return
        }
        if (existing.responseBody !== null && existing.responseStatus !== null) {
          const status = typeof existing.responseStatus === "number" ? existing.responseStatus : 200
          res.setHeader("idempotency-replayed", "true")
          res.status(status).json(existing.responseBody)
          return
        }
        // A row without a stored response means a concurrent request is still in
        // flight. Retrying is safe; serving a partial result is not.
        next(
          new AppError(PROBLEM_TYPES.CONFLICT, {
            detail: "A request with this Idempotency-Key is currently in progress.",
          })
        )
        return
      }

      const expiresAt = new Date(Date.now() + RETENTION_HOURS * 60 * 60 * 1000)
      await withWorkspace(
        ctx,
        async ({ tx, values }) =>
          tx.insert(idempotencyKeys).values(values({ key, requestFingerprint, expiresAt })),
        options.db
      )

      captureResponse(req, res, ctx, key, options.db)
      next()
    } catch (error) {
      next(error)
    }
  }
}

/** Wraps res.json so the first successful response is persisted for replay. */
function captureResponse(
  _req: Request,
  res: Response,
  ctx: { workspaceId: string },
  key: string,
  db: Database
): void {
  const originalJson = res.json.bind(res)

  res.json = function json(body: unknown) {
    // Only successful responses are worth replaying; a 500 should be retryable.
    if (res.statusCode >= 200 && res.statusCode < 300) {
      void withWorkspace(
        ctx,
        async ({ tx, scope }) =>
          tx
            .update(idempotencyKeys)
            .set({ responseStatus: res.statusCode, responseBody: body, updatedAt: new Date() })
            .where(scope(idempotencyKeys, eq(idempotencyKeys.key, key))),
        db
      ).catch(() => undefined)
    }
    return originalJson(body)
  }
}
