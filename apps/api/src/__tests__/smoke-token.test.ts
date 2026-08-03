import { createHmac, randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { jwtVerify } from "jose"

/**
 * The smoke bootstrap (packages/db/src/smoke.ts) mints a JWT by hand so a fresh
 * deployment can be exercised without a running Supabase login flow. This test
 * pins that token to what the auth middleware actually accepts - a token the
 * middleware rejects would make the whole manual test useless and look like a
 * deployment problem.
 *
 * Kept in sync deliberately: if the middleware's expectations change, this fails
 * rather than the operator discovering it against a live server.
 */

const SECRET = "s".repeat(48)
const ISSUER = "https://db-alg-nexoro.averio.agency/auth/v1"

/** Mirrors signJwt() in packages/db/src/smoke.ts. */
function signJwt(payload: Record<string, unknown>, secret: string): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url")

  const header = encode({ alg: "HS256", typ: "JWT" })
  const body = encode(payload)
  const signature = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url")

  return `${header}.${body}.${signature}`
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000)
  return {
    sub: randomUUID(),
    email: "smoke@averio.agency",
    role: "authenticated",
    aud: "authenticated",
    iss: ISSUER,
    iat: now,
    exp: now + 3600,
    ...overrides,
  }
}

describe("smoke bootstrap token", () => {
  it("verifies exactly the way the auth middleware does", async () => {
    const payload = claims()
    const token = signJwt(payload, SECRET)

    const verified = await jwtVerify(token, new TextEncoder().encode(SECRET), {
      algorithms: ["HS256"],
      issuer: ISSUER,
    })

    expect(verified.payload.sub).toBe(payload.sub)
  })

  it("carries a uuid subject, which the middleware requires", () => {
    const payload = claims()
    expect(String(payload.sub)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    )
  })

  it("is rejected when signed with a different secret", async () => {
    const token = signJwt(claims(), "o".repeat(48))

    await expect(
      jwtVerify(token, new TextEncoder().encode(SECRET), {
        algorithms: ["HS256"],
        issuer: ISSUER,
      })
    ).rejects.toThrow()
  })

  it("is rejected when the issuer does not match", async () => {
    // The middleware derives the issuer from SUPABASE_URL; a mismatch there is
    // a configuration error that should surface as a failed login, not silently.
    const token = signJwt(claims({ iss: "https://elsewhere.example/auth/v1" }), SECRET)

    await expect(
      jwtVerify(token, new TextEncoder().encode(SECRET), {
        algorithms: ["HS256"],
        issuer: ISSUER,
      })
    ).rejects.toThrow()
  })

  it("is rejected once expired", async () => {
    const past = Math.floor(Date.now() / 1000) - 7200
    const token = signJwt(claims({ iat: past, exp: past + 60 }), SECRET)

    await expect(
      jwtVerify(token, new TextEncoder().encode(SECRET), {
        algorithms: ["HS256"],
        issuer: ISSUER,
      })
    ).rejects.toThrow()
  })
})
