import { pipeline } from "node:stream/promises"
import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { eq } from "drizzle-orm"
import { files, withWorkspace, type Database } from "@alg/db"
import { FileNotFoundError, InvalidTokenError, verifyFileToken, type FileStorage } from "@alg/core"
import { AppError, PROBLEM_TYPES } from "@alg/shared"
import { requireContext } from "../middleware/auth.js"

/**
 * File delivery.
 *
 * Traefik does not serve the storage directory - everything goes through these two
 * handlers so that access is checked. Neither of them ever sees a path: the id (or
 * the id inside a signed token) is looked up in the files table and the path comes
 * from there.
 */

const ParamsSchema = z.object({ id: z.uuid() })
const TokenParamsSchema = z.object({ token: z.string().min(1).max(2048) })

export interface FilesRouterOptions {
  db: Database
  storage: FileStorage
  signingSecret: string
}

export function createFilesRouter(options: FilesRouterOptions): Router {
  const router = Router()

  /** Authenticated download, scoped to the caller's workspace. */
  router.get("/files/:id", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = requireContext(req)
      const { id } = ParamsSchema.parse(req.params)

      const [row] = await withWorkspace(
        ctx,
        async ({ tx, scope }) =>
          tx
            .select()
            .from(files)
            .where(scope(files, eq(files.id, id)))
            .limit(1),
        options.db
      )

      if (!row) {
        // The workspace filter already ran, so a miss means either "does not exist"
        // or "belongs to someone else". Both are 404 - the distinction would leak.
        throw new AppError(PROBLEM_TYPES.NOT_FOUND, { detail: "File not found." })
      }

      await streamFile(options.storage, row.id, row.mime, row.sizeBytes, res)
    } catch (error) {
      next(normalizeStorageError(error))
    }
  })

  /**
   * Public, signed, expiring link. Used for report URLs that recipients open
   * without an account. The token carries the file id and an expiry, never a path.
   */
  router.get("/r/:token", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token } = TokenParamsSchema.parse(req.params)

      const claims = verifyFileToken({ token, secret: options.signingSecret })
      const info = await options.storage.stat(claims.fileId)

      res.setHeader("cache-control", "private, max-age=300")
      res.setHeader("x-robots-tag", "noindex, nofollow")
      await streamFile(options.storage, claims.fileId, info.mime, info.size, res)
    } catch (error) {
      next(normalizeStorageError(error))
    }
  })

  return router
}

async function streamFile(
  storage: FileStorage,
  id: string,
  mime: string,
  size: number,
  res: Response
): Promise<void> {
  const stream = await storage.get(id)

  res.setHeader("content-type", mime)
  res.setHeader("content-length", String(size))
  // Never let a stored HTML artifact execute in the origin's context.
  res.setHeader("content-security-policy", "default-src 'none'; sandbox")
  res.setHeader("x-content-type-options", "nosniff")

  await pipeline(stream, res)
}

function normalizeStorageError(error: unknown): unknown {
  if (error instanceof FileNotFoundError) {
    return new AppError(PROBLEM_TYPES.STORAGE_OBJECT_MISSING, {
      detail: "The file is no longer available.",
    })
  }
  if (error instanceof InvalidTokenError) {
    return new AppError(PROBLEM_TYPES.INVALID_SIGNED_TOKEN, {
      detail: "The link is invalid or has expired.",
    })
  }
  return error
}
