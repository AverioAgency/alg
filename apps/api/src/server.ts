import { Redis } from "ioredis"
import { initDb, closeDb } from "@alg/db"
import { LocalFileStorage } from "@alg/core"
import { loadEnv } from "@alg/shared"
import { createApp } from "./app.js"
import { createLogger } from "./logger.js"

const VERSION = "0.1.0"
const GB = 1024 * 1024 * 1024

async function main(): Promise<void> {
  const env = loadEnv()
  const logger = createLogger({
    level: env.LOG_LEVEL,
    nodeEnv: env.NODE_ENV,
    service: "api",
  })

  const db = initDb({ connectionString: env.DATABASE_URL })
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null })

  const storage = new LocalFileStorage({
    root: env.ALG_STORAGE_PATH,
    maxBytes: env.ALG_STORAGE_MAX_GB * GB,
    db,
  })

  const app = createApp({ env, db, redis, storage, logger, version: VERSION })

  const server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, env: env.NODE_ENV, sendingEnabled: env.ALG_SENDING_ENABLED },
      "api listening"
    )
    if (!env.ALG_SENDING_ENABLED) {
      logger.warn({}, "ALG_SENDING_ENABLED is false - all outbound channels will refuse to send")
    }
  })

  const shutdown = (signal: string): void => {
    logger.info({ signal }, "shutting down")
    server.close(() => {
      void (async () => {
        await closeDb()
        redis.disconnect()
        process.exit(0)
      })()
    })
    // Do not let a hung connection block the deploy indefinitely.
    setTimeout(() => process.exit(1), 15_000).unref()
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"))
  process.on("SIGINT", () => shutdown("SIGINT"))
}

main().catch((error: unknown) => {
  console.error("Failed to start API:", error)
  process.exit(1)
})
