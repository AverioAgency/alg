import { Router, type Request, type Response } from "express"
import { sql } from "drizzle-orm"
import { type Redis } from "ioredis"
import { withoutWorkspaceScope, type Database } from "@alg/db"
import { type FileStorage } from "@alg/core"
import { type StorageUsage } from "@alg/shared"

/**
 * /v1/health is unauthenticated and cheap: it reports what the process itself knows
 * plus storage fill level, which is the number that decides whether screenshot jobs
 * keep running.
 *
 * /v1/ready additionally touches Postgres and Redis and is what the container
 * orchestrator gates traffic on.
 */

export interface HealthRouterOptions {
  db: Database
  redis: Redis
  storage: FileStorage
  version: string
  sendingEnabled: boolean
}

type ComponentStatus = "ok" | "degraded" | "down"

interface HealthResponse {
  status: ComponentStatus
  version: string
  uptimeSeconds: number
  sendingEnabled: boolean
  storage: StorageUsage | { status: "unavailable" }
}

export function createHealthRouter(options: HealthRouterOptions): Router {
  const router = Router()
  const startedAt = Date.now()

  router.get("/health", async (_req: Request, res: Response) => {
    let storage: HealthResponse["storage"]
    let status: ComponentStatus = "ok"

    try {
      const usage = await options.storage.usage()
      storage = usage
      // Over the soft cap the API still serves requests, but screenshot work pauses -
      // that is a degraded state an operator should see, not a silent one.
      if (usage.overSoftLimit) status = "degraded"
    } catch {
      storage = { status: "unavailable" }
      status = "degraded"
    }

    const body: HealthResponse = {
      status,
      version: options.version,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      sendingEnabled: options.sendingEnabled,
      storage,
    }

    // Degraded still answers 200: the API is serving traffic, and flapping the
    // health endpoint over a full disk would take the service out entirely.
    res.status(200).json(body)
  })

  router.get("/ready", async (_req: Request, res: Response) => {
    const checks: Record<string, ComponentStatus> = {}

    try {
      await withoutWorkspaceScope(
        "Liveness probe against the connection pool; there is no workspace context on a readiness check.",
        async (db) => db.execute(sql`SELECT 1`),
        options.db
      )
      checks.database = "ok"
    } catch {
      checks.database = "down"
    }

    try {
      const pong = await options.redis.ping()
      checks.redis = pong === "PONG" ? "ok" : "degraded"
    } catch {
      checks.redis = "down"
    }

    try {
      await options.storage.usage()
      checks.storage = "ok"
    } catch {
      checks.storage = "down"
    }

    const ready = Object.values(checks).every((value) => value === "ok")
    res.status(ready ? 200 : 503).json({ status: ready ? "ok" : "down", checks })
  })

  return router
}
