import express, { type Express } from "express"
import helmet from "helmet"
import { pinoHttp } from "pino-http"
import { Queue } from "bullmq"
import { type Redis } from "ioredis"
import { type Database } from "@alg/db"
import { type FileStorage } from "@alg/core"
import { type Env } from "@alg/shared"
import { type Logger } from "./logger.js"
import { createAuthMiddleware } from "./middleware/auth.js"
import { createErrorHandler, notFoundHandler } from "./middleware/error.js"
import { createIdempotencyMiddleware } from "./middleware/idempotency.js"
import { createCorsMiddleware } from "./middleware/cors.js"
import { createServiceAuthMiddleware } from "./middleware/service-auth.js"
import { createRateLimiters, ipRateLimit, workspaceRateLimit } from "./middleware/rate-limit.js"
import { requestId } from "./middleware/request-id.js"
import { createFilesRouter } from "./routes/files.js"
import { createHealthRouter } from "./routes/health.js"
import { createCompaniesRouter } from "./routes/companies.js"
import { createSearchesRouter } from "./routes/searches.js"
import { createStreamsRouter } from "./routes/streams.js"
import { createSignalsRouter } from "./routes/signals.js"
import { createRubricsRouter } from "./routes/rubrics.js"
import { createClarifyRouter } from "./routes/clarify.js"
import { createLlmClientFromEnv } from "@alg/core"
import { buildSignalRegistry } from "@alg/adapters-signals"
import { openApiDocument } from "./openapi.js"
import { renderDocsPage } from "./docs.js"

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
      // cross-origin, not same-site: the Nexoro frontend is a different site, and
      // same-site would have the browser discard responses CORS just allowed.
      // CORP guards embedding (an <img> or <script> pulling a response); which
      // origins may *read* it is decided by the allowlist below.
      crossOriginResourcePolicy: { policy: "cross-origin" },
    })
  )

  // Before the rate limiters: a preflight carries no credentials and must not
  // consume a client's budget, and a 429 on OPTIONS surfaces in the browser as
  // an opaque CORS failure rather than as rate limiting.
  app.use(createCorsMiddleware({ origins: env.ALG_CORS_ORIGINS }))
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

  /**
   * The human-readable API reference, generated from the same document.
   *
   * Public and mounted before the auth middleware: whoever is wiring up the
   * frontend needs to read it before they have a token, and it exposes nothing a
   * caller could not read from /v1/openapi.json anyway.
   *
   * Helmet's default CSP is disabled for JSON responses, so this route sets its
   * own - the page is self-contained, and `default-src 'none'` plus inline
   * styles is exactly what it needs.
   */
  app.get("/docs", (_req, res) => {
    res
      .type("html")
      .setHeader(
        "content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"
      )
    // Not cached: a redeploy changes the routes, and a stale reference is worse
    // than a slow one.
    res.setHeader("cache-control", "no-cache")
    res.send(renderDocsPage(openApiDocument(version), version))
  })

  // /docs without the /v1 prefix is the memorable form; both work.
  app.get("/v1/docs", (_req, res) => res.redirect(302, "/docs"))

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

  /**
   * Two ways in, tried in order.
   *
   * The Nexoro PHP backend presents a service token and names the acting user;
   * everyone else presents a Supabase JWT. Service auth runs first and only
   * engages when its header is present, so a request without it reaches the
   * Supabase path exactly as before.
   */
  app.use(
    "/v1",
    createServiceAuthMiddleware({
      db,
      serviceToken: env.ALG_SERVICE_TOKEN,
      tenantDomain: env.ALG_TENANT_DOMAIN,
      // Requested explicitly: an unseen subdomain becomes a workspace on first
      // contact. The reserved-slug list and strict hostname parsing in
      // @alg/shared are what keep that from being abusable.
      autoProvision: true,
    })
  )

  // Skipped when service auth already established a context - re-verifying would
  // demand a Supabase token the PHP backend does not have.
  app.use("/v1", (req, res, next) => {
    if (req.ctx) {
      next()
      return
    }
    void authenticate(req, res, next)
  })
  app.use("/v1", workspaceRateLimit(limiters))
  app.use("/v1", createIdempotencyMiddleware({ db }))
  app.use("/v1", filesRouter)

  // The API only enqueues discovery work; the worker consumes it.
  const discoveryQueue = new Queue("discovery", { connection: redis })

  app.use("/v1", createCompaniesRouter({ db }))
  app.use("/v1", createSearchesRouter({ db, discoveryQueue }))
  app.use("/v1", createStreamsRouter({ db }))

  // One registry for the process: the crawler inside it holds the per-host rate
  // limit, which only works if every request goes through the same instance.
  const signalRegistry = buildSignalRegistry({ userAgent: env.ALG_USER_AGENT })
  const enrichmentQueue = new Queue("enrichment", { connection: redis })
  app.use("/v1", createSignalsRouter({ db, registry: signalRegistry, enrichmentQueue }))

  // null without a key: the rubric then scores on rules alone and /rubrics/suggest
  // answers 503 with its own slug, rather than the deployment failing to boot.
  const llmClient = createLlmClientFromEnv(env)
  const scoringQueue = new Queue("scoring", { connection: redis })
  app.use("/v1", createRubricsRouter({ db, registry: signalRegistry, scoringQueue, llmClient }))

  // Stateless: the client sends the description and answers, the server computes
  // the questions. No draft table and no half-finished wizards left behind.
  app.use("/v1", createClarifyRouter({ db, registry: signalRegistry }))

  app.use(notFoundHandler)
  app.use(createErrorHandler(logger))

  return app
}
