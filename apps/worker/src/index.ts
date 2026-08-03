import { Queue, Worker, type Job } from "bullmq"
import { Redis } from "ioredis"
import pino from "pino"
import { lt } from "drizzle-orm"
import { closeDb, idempotencyKeys, initDb, withoutWorkspaceScope } from "@alg/db"
import { LocalFileStorage, runStorageCleanup } from "@alg/core"
import { loadEnv } from "@alg/shared"
import { DEFAULT_JOB_OPTIONS, JOB_NAMES, QUEUE_NAMES } from "./queues.js"
import { createDiscoveryWorker } from "./discovery-worker.js"

const GB = 1024 * 1024 * 1024

async function main(): Promise<void> {
  const env = loadEnv()
  const logger = pino({
    level: env.LOG_LEVEL,
    name: "worker",
    redact: {
      paths: ["*.email", "*.phone", "*.firstName", "*.lastName", "*.token", "*.secret"],
      censor: "[redacted]",
    },
    base: { service: "worker", env: env.NODE_ENV },
  })

  const db = initDb({ connectionString: env.DATABASE_URL })
  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null })

  const storage = new LocalFileStorage({
    root: env.ALG_STORAGE_PATH,
    maxBytes: env.ALG_STORAGE_MAX_GB * GB,
    db,
  })

  const maintenance = new Queue(QUEUE_NAMES.MAINTENANCE, { connection })

  // Retention sweep: expired files, orphans on disk, rows without a file.
  await maintenance.upsertJobScheduler(
    JOB_NAMES.STORAGE_CLEANUP,
    { pattern: "0 3 * * *" },
    { name: JOB_NAMES.STORAGE_CLEANUP, opts: DEFAULT_JOB_OPTIONS }
  )
  await maintenance.upsertJobScheduler(
    JOB_NAMES.IDEMPOTENCY_CLEANUP,
    { pattern: "30 3 * * *" },
    { name: JOB_NAMES.IDEMPOTENCY_CLEANUP, opts: DEFAULT_JOB_OPTIONS }
  )

  const maintenanceWorker = new Worker(
    QUEUE_NAMES.MAINTENANCE,
    async (job: Job) => {
      switch (job.name) {
        case JOB_NAMES.STORAGE_CLEANUP: {
          const report = await runStorageCleanup({
            root: env.ALG_STORAGE_PATH,
            db,
            logger,
          })
          logger.info({ report }, "storage cleanup finished")
          const usage = await storage.usage()
          if (usage.overSoftLimit) {
            logger.warn(
              { usedPercent: usage.usedPercent },
              "storage still over the soft limit after cleanup - screenshot jobs stay paused"
            )
          }
          return report
        }
        case JOB_NAMES.IDEMPOTENCY_CLEANUP: {
          await withoutWorkspaceScope(
            "Expiry sweep over idempotency records runs host-wide across all workspaces.",
            async (database) =>
              database.delete(idempotencyKeys).where(lt(idempotencyKeys.expiresAt, new Date())),
            db
          )
          logger.info({}, "idempotency key cleanup finished")
          return null
        }
        default:
          logger.warn({ jobName: job.name }, "unknown maintenance job")
          return null
      }
    },
    { connection, concurrency: 1 }
  )

  maintenanceWorker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, jobName: job?.name, err: error }, "maintenance job failed")
  })

  const discoveryWorker = createDiscoveryWorker({ connection, db, env, logger })

  logger.info(
    { queues: Object.values(QUEUE_NAMES), sendingEnabled: env.ALG_SENDING_ENABLED },
    "worker started"
  )

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down worker")
    // Close consumers before the queue so an in-flight discovery run finishes.
    await discoveryWorker.close()
    await maintenanceWorker.close()
    await maintenance.close()
    await closeDb()
    connection.disconnect()
    process.exit(0)
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"))
  process.on("SIGINT", () => void shutdown("SIGINT"))
}

main().catch((error: unknown) => {
  console.error("Failed to start worker:", error)
  process.exit(1)
})
