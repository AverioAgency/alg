import { beforeEach, describe, expect, it } from "vitest"
import { EnvSchema, EnvValidationError, loadEnv, resetEnvCache } from "../env.js"

const VALID = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/alg",
  REDIS_URL: "redis://localhost:6379",
  SUPABASE_URL: "https://db-alg-nexoro.averio.agency",
  SUPABASE_JWT_SECRET: "x".repeat(48),
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  ALG_STORAGE_SIGNING_SECRET: "y".repeat(48),
  ENCRYPTION_MASTER_KEY: "z".repeat(48),
}

beforeEach(() => {
  resetEnvCache()
})

describe("EnvSchema", () => {
  it("accepts a minimal valid configuration and applies defaults", () => {
    const env = loadEnv(VALID)

    expect(env.NODE_ENV).toBe("development")
    expect(env.PORT).toBe(3000)
    expect(env.ALG_STORAGE_PATH).toBe("/data/alg/storage")
    expect(env.ALG_STORAGE_MAX_GB).toBe(50)
    expect(env.OVERPASS_ENDPOINT).toContain("overpass")
    expect(env.ALG_USER_AGENT).toBe("AlgBot/1.0 (+https://averio.agency/bot)")
  })

  it("defaults the sending kill switch to off", () => {
    // Anything other than an explicit opt-in must not send.
    expect(loadEnv(VALID).ALG_SENDING_ENABLED).toBe(false)
  })

  it("parses the kill switch from the usual string spellings", () => {
    for (const [raw, expected] of [
      ["true", true],
      ["TRUE", true],
      ["1", true],
      ["yes", true],
      ["false", false],
      ["0", false],
      ["no", false],
    ] as const) {
      resetEnvCache()
      expect(loadEnv({ ...VALID, ALG_SENDING_ENABLED: raw }).ALG_SENDING_ENABLED).toBe(expected)
    }
  })

  it("rejects a kill switch value it cannot interpret", () => {
    expect(() => loadEnv({ ...VALID, ALG_SENDING_ENABLED: "maybe" })).toThrow(EnvValidationError)
  })

  it("refuses to let staging enable sending", () => {
    expect(() => loadEnv({ ...VALID, NODE_ENV: "staging", ALG_SENDING_ENABLED: "true" })).toThrow(
      EnvValidationError
    )
  })

  it("allows production to enable sending", () => {
    const env = loadEnv({ ...VALID, NODE_ENV: "production", ALG_SENDING_ENABLED: "true" })
    expect(env.ALG_SENDING_ENABLED).toBe(true)
  })

  it("reports every missing variable at once rather than one per restart", () => {
    try {
      loadEnv({})
      expect.unreachable("should have thrown")
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError)
      const paths = (error as EnvValidationError).issues.map((i) => i.path)
      expect(paths).toContain("DATABASE_URL")
      expect(paths).toContain("SUPABASE_JWT_SECRET")
      expect(paths).toContain("ENCRYPTION_MASTER_KEY")
    }
  })

  it("treats an empty optional key as absent", () => {
    // A hand-written .env carries "ANTHROPIC_API_KEY=" rather than omitting the
    // line. Refusing to boot over a key that is not needed until M3 would block
    // the deploy for no reason.
    const env = loadEnv({
      ...VALID,
      ANTHROPIC_API_KEY: "",
      GOOGLE_PLACES_API_KEY: "",
      TWILIO_ACCOUNT_SID: "",
      TWILIO_AUTH_TOKEN: "",
      SCRAPER_TOKEN: "",
      SENTRY_DSN: "",
      SCRAPER_URL: "",
    })

    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.GOOGLE_PLACES_API_KEY).toBeUndefined()
    expect(env.SCRAPER_URL).toBeUndefined()
    expect(env.SENTRY_DSN).toBeUndefined()
  })

  it("still accepts optional keys when they are filled in", () => {
    const env = loadEnv({
      ...VALID,
      ANTHROPIC_API_KEY: "sk-ant-123",
      SCRAPER_URL: "http://scraper:4000",
    })

    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-123")
    expect(env.SCRAPER_URL).toBe("http://scraper:4000")
  })

  it("still rejects a malformed optional URL", () => {
    // Empty means "not configured"; nonsense means someone made a mistake.
    expect(() => loadEnv({ ...VALID, SCRAPER_URL: "not-a-url" })).toThrow(EnvValidationError)
  })

  it("rejects a short JWT secret", () => {
    expect(() => loadEnv({ ...VALID, SUPABASE_JWT_SECRET: "short" })).toThrow(EnvValidationError)
  })

  it("rejects a non-postgres DATABASE_URL", () => {
    expect(() => loadEnv({ ...VALID, DATABASE_URL: "mysql://localhost/alg" })).toThrow(
      EnvValidationError
    )
  })

  it("caches after the first successful load", () => {
    const first = loadEnv(VALID)
    const second = loadEnv({ ...VALID, PORT: "9999" })
    expect(second.PORT).toBe(first.PORT)
  })

  it("has no import-time side effects", () => {
    // The frontend imports @alg/shared without any of these variables set;
    // parsing the schema must be something the caller opts into.
    expect(() => EnvSchema.safeParse({})).not.toThrow()
  })
})
