import express, { type Express } from "express"
import helmet from "helmet"
import { pinoHttp } from "pino-http"
import { type Redis } from "ioredis"
import { type Database } from "@alg/db"
import { type FileStorage } from "@alg/core"
import { type Env } from "@alg/shared"
import { type Logger } from "./logger.js"
import { createAuthMiddleware } from "./middleware/auth.js"
import { createErrorHandler, notFoundHandler } from "./middleware/error.js"
import { createIdempotencyMiddleware } from "./middleware/idempotency.js"
import { createRateLimiters, ipRateLimit, workspaceRateLimit } from "./middleware/rate-limit.js"
import { requestId } from "./middleware/request-id.js"
import { createFilesRouter } from "./routes/files.js"
import { createHealthRouter } from "./routes/health.js"
import { openApiDocument } from "./openapi.js"

export interface AppOptions {
  env: Env
  db: Database
  redis: Redis
  storage: FileStorage
  logger: Logger
  version?: string
}

export function createApp(options: AppOptions): Express {
  const { env, db, redis, storage, logger } = options
  const app = express()

  // Traefik terminates TLS and sets X-Forwarded-*; without this req.ip is the
  // proxy's address and the per-IP rate limit would bucket every client together.
  app.set("trust proxy", 1)
  app.disable("x-powered-by")

  app.use(requestId)
  app.use(
    helmet({
      contentSecurityPolicy: false, // API returns JSON; per-response CSP is set on file streams.
      crossOriginResourcePolicy: { policy: "same-site" },
    })
  )
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => String(req.headers["x-request-id"] ?? ""),
      autoLogging: {
        // Health probes fire every few seconds; logging them buries real traffic.
        ignore: (req) => req.url === "/v1/health" || req.url === "/v1/ready",
      },
    })
  )

  const limiters = createRateLimiters({ redis })
  app.use(ipRateLimit(limiters))

  app.use(express.json({ limit: "1mb" }))

  const version = options.version ?? "0.1.0"

  // Health and readiness stay unauthenticated: the orchestrator has no token.
  app.use(
    "/v1",
    createHealthRouter({
      db,
      redis,
      storage,
      version,
      sendingEnabled: env.ALG_SENDING_ENABLED,
    })
  )

  app.get("/v1/openapi.json", (_req, res) => {
    res.json(openApiDocument(version))
  })

  // Signed report links are public by design and must not require a workspace header,
  // so this router is mounted before the auth middleware. Access is proven by the
  // HMAC signature instead.
  const filesRouter = createFilesRouter({
    db,
    storage,
    signingSecret: env.ALG_STORAGE_SIGNING_SECRET,
  })
  app.use("/v1", (req, res, next) => {
    if (req.path.startsWith("/r/")) {
      filesRouter(req, res, next)
      return
    }
    next()
  })

  const authenticate = createAuthMiddleware({
    jwtSecret: env.SUPABASE_JWT_SECRET,
    db,
    issuer: `${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1`,
  })

  app.use("/v1", authenticate)
  app.use("/v1", workspaceRateLimit(limiters))
  app.use("/v1", createIdempotencyMiddleware({ db }))
  app.use("/v1", filesRouter)

  app.use(notFoundHandler)
  app.use(createErrorHandler(logger))

  return app
}
