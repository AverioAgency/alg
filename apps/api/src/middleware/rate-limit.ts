import { type NextFunction, type Request, type Response } from "express"
import { RateLimiterRedis, type RateLimiterAbstract } from "rate-limiter-flexible"
import { type Redis } from "ioredis"
import { AppError, PROBLEM_TYPES } from "@alg/shared"

/**
 * Two independent limiters: one per IP (blunt, protects the unauthenticated
 * surface) and one per workspace (protects tenants from each other). Both are
 * Redis-backed so limits hold across API replicas.
 */

export interface RateLimitOptions {
  redis: Redis
  /** Requests per window, per IP. */
  ipPoints?: number
  /** Requests per window, per workspace. */
  workspacePoints?: number
  durationSeconds?: number
}

export interface RateLimiters {
  byIp: RateLimiterAbstract
  byWorkspace: RateLimiterAbstract
}

export function createRateLimiters(options: RateLimitOptions): RateLimiters {
  const duration = options.durationSeconds ?? 60

  return {
    byIp: new RateLimiterRedis({
      storeClient: options.redis,
      keyPrefix: "rl:ip",
      points: options.ipPoints ?? 300,
      duration,
    }),
    byWorkspace: new RateLimiterRedis({
      storeClient: options.redis,
      keyPrefix: "rl:ws",
      points: options.workspacePoints ?? 1_000,
      duration,
    }),
  }
}

function retryAfterSeconds(msBeforeNext: number): number {
  return Math.max(1, Math.ceil(msBeforeNext / 1000))
}

/** Runs before auth: the only key available is the client address. */
export function ipRateLimit(limiters: RateLimiters) {
  return async function limit(req: Request, res: Response, next: NextFunction): Promise<void> {
    const key = req.ip ?? "unknown"
    try {
      await limiters.byIp.consume(key)
      next()
    } catch (rejection) {
      const wait = getMsBeforeNext(rejection)
      if (wait === null) {
        // Redis is down. Fail open rather than taking the whole API offline with it.
        next()
        return
      }
      res.setHeader("retry-after", retryAfterSeconds(wait))
      next(new AppError(PROBLEM_TYPES.RATE_LIMITED, { detail: "IP rate limit exceeded." }))
    }
  }
}

/** Runs after auth, so req.ctx.workspaceId is available. */
export function workspaceRateLimit(limiters: RateLimiters) {
  return async function limit(req: Request, res: Response, next: NextFunction): Promise<void> {
    const workspaceId = req.ctx?.workspaceId
    if (!workspaceId) {
      next()
      return
    }
    try {
      await limiters.byWorkspace.consume(workspaceId)
      next()
    } catch (rejection) {
      const wait = getMsBeforeNext(rejection)
      if (wait === null) {
        next()
        return
      }
      res.setHeader("retry-after", retryAfterSeconds(wait))
      next(new AppError(PROBLEM_TYPES.RATE_LIMITED, { detail: "Workspace rate limit exceeded." }))
    }
  }
}

/**
 * rate-limiter-flexible rejects with a RateLimiterRes on an exceeded limit but with
 * a genuine Error when the store is unreachable. Only the former carries msBeforeNext.
 */
function getMsBeforeNext(rejection: unknown): number | null {
  if (rejection instanceof Error) return null
  if (typeof rejection === "object" && rejection !== null && "msBeforeNext" in rejection) {
    const value = (rejection as { msBeforeNext: unknown }).msBeforeNext
    return typeof value === "number" ? value : null
  }
  return null
}
