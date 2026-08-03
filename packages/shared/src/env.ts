import { z } from "zod"

/**
 * Every configuration value the backend reads, validated once at boot.
 *
 * This module is deliberately side-effect free: the schema is exported, but
 * nothing is parsed at import time. @alg/shared is also consumed by the frontend,
 * which has none of these variables set - importing it must never throw.
 * Server entrypoints call loadEnv() explicitly.
 */

const booleanFromString = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.enum(["true", "false", "1", "0", "yes", "no"]))
  .transform((v) => v === "true" || v === "1" || v === "yes")

const port = z.coerce.number().int().min(1).max(65535)

/**
 * An optional secret that is legitimately absent until the milestone that needs it.
 *
 * `.optional()` alone is not enough: a .env file written by hand almost always
 * carries `ANTHROPIC_API_KEY=` rather than omitting the line, and an empty string
 * is a present value that fails a min(1) check. Treating "" as absent is what
 * makes a partially configured deploy boot instead of dying on a key it does not
 * use yet.
 */
const optionalSecret = z
  .string()
  .transform((value) => (value.trim() === "" ? undefined : value))
  .optional()

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  PORT: port.default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  DATABASE_URL: z.string().min(1).startsWith("postgres"),
  REDIS_URL: z.string().min(1).startsWith("redis"),

  SUPABASE_URL: z.url(),
  /**
   * HS256 secret used by this Supabase project to sign user JWTs. Self-hosted
   * Supabase uses the symmetric legacy scheme; if the project is ever migrated to
   * asymmetric keys (JWKS), the auth middleware needs to change with it.
   */
  SUPABASE_JWT_SECRET: z.string().min(32),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  ALG_STORAGE_PATH: z.string().min(1).default("/data/alg/storage"),
  /** Soft cap. Exceeding it pauses new screenshot jobs rather than filling the disk. */
  ALG_STORAGE_MAX_GB: z.coerce.number().positive().default(50),
  /** HMAC key for public, expiring report links (GET /v1/r/:token). */
  ALG_STORAGE_SIGNING_SECRET: z.string().min(32),

  /** Master key for pgcrypto-encrypted credentials. 32 bytes, base64. */
  ENCRYPTION_MASTER_KEY: z.string().min(32),

  ANTHROPIC_API_KEY: optionalSecret,
  ANTHROPIC_MODEL_FAST: z.string().min(1).default("claude-haiku-4-5-20251001"),
  ANTHROPIC_MODEL_SMART: z.string().min(1).default("claude-sonnet-5"),

  GOOGLE_PLACES_API_KEY: optionalSecret,
  OVERPASS_ENDPOINT: z.url().default("https://overpass-api.de/api/interpreter"),

  TWILIO_ACCOUNT_SID: optionalSecret,
  TWILIO_AUTH_TOKEN: optionalSecret,

  // .optional() must wrap the whole chain: the variable may be absent entirely,
  // present but empty, or present and required to be a valid URL.
  SCRAPER_URL: z
    .string()
    .transform((value) => (value.trim() === "" ? undefined : value))
    .pipe(z.url().optional())
    .optional(),
  SCRAPER_TOKEN: optionalSecret,

  /**
   * Global kill switch. When false, every channel adapter throws instead of
   * sending. Staging and test must keep this false.
   */
  ALG_SENDING_ENABLED: booleanFromString.default(false),
  ALG_MONTHLY_BUDGET_EUR: z.coerce.number().nonnegative().default(0),

  /** User-Agent the crawler identifies itself with. */
  ALG_USER_AGENT: z.string().min(1).default("AlgBot/1.0 (+https://averio.agency/bot)"),

  /**
   * Shared secret for the trusted-service path.
   *
   * The Nexoro frontend (PHP, OMS cluster) authenticates its own users and calls
   * ALG server-to-server. It presents this secret plus the acting tenant instead
   * of a Supabase user token - which is only sound because the call comes from a
   * server we operate, never from a browser. See createServiceAuthMiddleware.
   *
   * Optional: without it the service path is disabled entirely rather than
   * falling back to something weaker.
   */
  ALG_SERVICE_TOKEN: optionalSecret,

  /**
   * Origins allowed to call this API from a browser, comma-separated.
   *
   * Empty means no browser may call it, which is the correct default: this API
   * carries lead data under GDPR, and a permissive CORS rule on an authenticated
   * origin is worth more to an attacker than to us. `*` is rejected outright -
   * see parseAllowedOrigins.
   */
  ALG_CORS_ORIGINS: z.string().default(""),

  /**
   * Domain whose subdomains name a workspace, e.g. "nexoro.net" turns
   * nexoro.nexoro.net into the workspace slug "nexoro".
   *
   * Empty disables subdomain resolution; the x-workspace-id header is then the
   * only way to name a workspace.
   */
  ALG_TENANT_DOMAIN: z.string().default(""),

  SENTRY_DSN: optionalSecret,
  PUBLIC_BASE_URL: z.url().default("http://localhost:3000"),
})

export type Env = z.infer<typeof EnvSchema>

export class EnvValidationError extends Error {
  readonly issues: { path: string; message: string }[]

  constructor(issues: { path: string; message: string }[]) {
    const summary = issues.map((i) => `  - ${i.path}: ${i.message}`).join("\n")
    super(`Invalid environment configuration:\n${summary}`)
    this.name = "EnvValidationError"
    this.issues = issues
  }
}

let cached: Env | null = null

/**
 * Parses and caches process.env. Call once at service startup - failing fast on a
 * misconfigured deploy is the point.
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  if (cached) return cached

  const result = EnvSchema.safeParse(source)
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.join(".") || "(root)",
        message: issue.message,
      }))
    )
  }

  // Production must never run with an unguarded sending switch flipped on by accident,
  // and staging must never send at all.
  if (result.data.NODE_ENV === "staging" && result.data.ALG_SENDING_ENABLED) {
    throw new EnvValidationError([
      {
        path: "ALG_SENDING_ENABLED",
        message: "must be false in staging - staging never sends real messages",
      },
    ])
  }

  cached = result.data
  return cached
}

/** Test-only: drops the cached env so a fresh set of variables can be loaded. */
export function resetEnvCache(): void {
  cached = null
}
