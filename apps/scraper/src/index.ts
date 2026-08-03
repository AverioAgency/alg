import express from "express"
import pino from "pino"
import { loadEnv } from "@alg/shared"

/**
 * Internal scraping service.
 *
 * M0 ships only the process skeleton and its bearer-token guard: the container,
 * the network placement (no route from Traefik, no access to internal services)
 * and the shared storage mount all need to exist before M2 adds Playwright,
 * robots.txt handling and the SSRF-blocking fetch layer on top.
 */
async function main(): Promise<void> {
  const env = loadEnv()
  const logger = pino({
    level: env.LOG_LEVEL,
    name: "scraper",
    base: { service: "scraper", env: env.NODE_ENV },
  })

  const app = express()
  app.disable("x-powered-by")
  app.use(express.json({ limit: "256kb" }))

  // Only api and worker may call this service, and only with the shared token.
  app.use((req, res, next) => {
    if (req.path === "/health") {
      next()
      return
    }
    const token = req.header("authorization")?.replace(/^Bearer\s+/i, "")
    if (!env.SCRAPER_TOKEN || token !== env.SCRAPER_TOKEN) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    next()
  })

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "scraper", playwright: "pending-m2" })
  })

  const port = 4000
  const server = app.listen(port, () => {
    logger.info({ port }, "scraper listening on the internal network")
  })

  const shutdown = (signal: string): void => {
    logger.info({ signal }, "shutting down scraper")
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(1), 10_000).unref()
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"))
  process.on("SIGINT", () => shutdown("SIGINT"))
}

main().catch((error: unknown) => {
  console.error("Failed to start scraper:", error)
  process.exit(1)
})
