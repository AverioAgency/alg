import { describe, expect, it } from "vitest"
import { AppError, PROBLEM_TYPES } from "@alg/shared"
import {
  createServiceAuthMiddleware,
  deriveUserId,
  type ServiceAuthOptions,
} from "../middleware/service-auth.js"

/**
 * The trusted-service path.
 *
 * This is the one place where something other than a verified Supabase token
 * grants access to tenant data, so the tests are mostly about refusal: a wrong
 * secret, a forged hostname, a slug that names infrastructure. The convenience
 * cases are one-liners by comparison.
 */

const SECRET = "s3rv1ce-t0ken-with-enough-entropy-to-be-real"
const DOMAIN = "nexoro.net"

import { createFakeDb, type FakeState } from "./helpers/fake-db.js"

interface RunResult {
  ctx?: Record<string, unknown>
  error?: AppError
  state: FakeState
}

/**
 * Runs the middleware against a fake database and reports what came out.
 *
 * The fake cannot evaluate Drizzle predicates, so the slug being resolved is
 * threaded in explicitly - derived here the same way the middleware derives it.
 */
async function run(
  headers: Record<string, string>,
  overrides: Partial<ServiceAuthOptions> = {},
  seed: Partial<FakeState> = {}
): Promise<RunResult> {
  const { db, state } = createFakeDb(seed)

  const host = headers["x-forwarded-host"] ?? headers.host ?? ""
  state.lookingForSlug = headers["x-workspace-slug"] ?? host.split(".")[0] ?? ""

  const middleware = createServiceAuthMiddleware({
    db,
    serviceToken: SECRET,
    tenantDomain: DOMAIN,
    autoProvision: true,
    ...overrides,
  })

  const req = {
    headers,
    header(name: string): string | undefined {
      return headers[name.toLowerCase()]
    },
  }

  return await new Promise<RunResult>((resolve) => {
    void middleware(
      req as never,
      {} as never,
      ((error?: unknown) => {
        if (error) {
          resolve({ error: error instanceof AppError ? error : undefined, state })
          return
        }
        resolve({ ctx: (req as { ctx?: Record<string, unknown> }).ctx, state })
      }) as never
    )
  })
}

describe("no service token present", () => {
  it("falls through so the Supabase path can run", async () => {
    // Both ways in are legitimate; this middleware must not claim every request.
    const { ctx, error } = await run({ host: "nexoro.nexoro.net" })
    expect(error).toBeUndefined()
    expect(ctx).toBeUndefined()
  })
})

describe("secret verification", () => {
  it("rejects a wrong token", async () => {
    const { error } = await run({
      "x-alg-service-token": "wrong",
      host: "nexoro.nexoro.net",
    })
    expect(error).toBeInstanceOf(AppError)
    expect(error?.slug).toBe(PROBLEM_TYPES.UNAUTHENTICATED)
  })

  it("rejects a token that is a prefix of the real one", async () => {
    // Guards the length-comparison shortcut a naive check would take.
    const { error } = await run({
      "x-alg-service-token": SECRET.slice(0, 10),
      host: "nexoro.nexoro.net",
    })
    expect(error?.slug).toBe(PROBLEM_TYPES.UNAUTHENTICATED)
  })

  it("rejects every token when the deployment has none configured", async () => {
    // Unconfigured must disable the path, never accept anything.
    const { error } = await run(
      { "x-alg-service-token": SECRET, host: "nexoro.nexoro.net" },
      { serviceToken: undefined }
    )
    expect(error?.slug).toBe(PROBLEM_TYPES.UNAUTHENTICATED)
  })
})

describe("workspace from the hostname", () => {
  const auth = { "x-alg-service-token": SECRET }

  it("resolves an existing workspace by subdomain", async () => {
    const { ctx, error } = await run(
      { ...auth, host: "nexoro.nexoro.net" },
      {},
      {
        workspaces: [{ id: "11111111-1111-4111-8111-111111111111", slug: "nexoro" }],
      }
    )

    expect(error).toBeUndefined()
    expect(ctx?.workspaceId).toBe("11111111-1111-4111-8111-111111111111")
    expect(ctx?.role).toBe("member")
  })

  it("creates the workspace on first contact", async () => {
    const { ctx, error, state } = await run({ ...auth, host: "kunde-a.nexoro.net" })

    expect(error).toBeUndefined()
    expect(ctx?.workspaceId).toBeDefined()
    expect((state.workspaces as { slug: string }[]).map((w) => w.slug)).toContain("kunde-a")
  })

  it("refuses a reserved subdomain instead of creating a workspace for it", async () => {
    // "admin.nexoro.net" is either a typo or an attempt; either way it must not
    // become a tenant.
    const { error, state } = await run({ ...auth, host: "admin.nexoro.net" })

    expect(error?.slug).toBe(PROBLEM_TYPES.WORKSPACE_REQUIRED)
    expect(state.workspaces).toStrictEqual([])
  })

  it("refuses a nested subdomain", async () => {
    // nexoro.evil.nexoro.net must not read as the nexoro tenant.
    const { error } = await run({ ...auth, host: "nexoro.evil.nexoro.net" })
    expect(error?.slug).toBe(PROBLEM_TYPES.WORKSPACE_REQUIRED)
  })

  it("refuses a host outside the tenant domain", async () => {
    const { error } = await run({ ...auth, host: "nexoro.attacker.com" })
    expect(error?.slug).toBe(PROBLEM_TYPES.WORKSPACE_REQUIRED)
  })

  it("prefers the forwarded host, which is what the proxy sets", async () => {
    const { ctx } = await run({
      ...auth,
      host: "alg-nexoro.averio.agency",
      "x-forwarded-host": "kunde-b.nexoro.net",
    })
    expect(ctx?.workspaceId).toBeDefined()
  })

  it("accepts an explicit slug header from an authenticated service", async () => {
    // The PHP backend may act for a tenant other than the domain it was reached
    // on - it has already proven it holds the secret.
    const { ctx, error } = await run({
      ...auth,
      host: "alg-nexoro.averio.agency",
      "x-workspace-slug": "kunde-c",
    })
    expect(error).toBeUndefined()
    expect(ctx?.workspaceId).toBeDefined()
  })

  it("still validates an explicit slug", async () => {
    const { error } = await run({
      ...auth,
      host: "alg-nexoro.averio.agency",
      "x-workspace-slug": "admin",
    })
    expect(error?.slug).toBe(PROBLEM_TYPES.WORKSPACE_REQUIRED)
  })

  it("refuses to create when auto-provisioning is off", async () => {
    const { error } = await run({ ...auth, host: "neu.nexoro.net" }, { autoProvision: false })
    expect(error?.slug).toBe(PROBLEM_TYPES.NOT_FOUND)
  })
})

describe("the acting user", () => {
  const auth = { "x-alg-service-token": SECRET, host: "nexoro.nexoro.net" }

  it("mirrors the user the frontend names", async () => {
    const { ctx } = await run({ ...auth, "x-alg-user": "u-42" })
    expect(ctx?.userId).toBe(deriveUserId("nexoro", "u-42"))
  })

  it("falls back to a named service identity rather than a blank one", async () => {
    // An audit entry has to point at something; "service" is at least honest.
    const { ctx } = await run(auth)
    expect(ctx?.userId).toBe(deriveUserId("nexoro", "service"))
  })

  it("carries the email through when given", async () => {
    const { ctx } = await run({ ...auth, "x-alg-user-email": "anna@kunde.at" })
    expect(ctx?.email).toBe("anna@kunde.at")
  })

  it("grants member, never owner", async () => {
    // A service acting on someone's behalf should not be able to do owner-only
    // things unattended.
    const { ctx } = await run({ ...auth, "x-alg-user": "u-1" })
    expect(ctx?.role).toBe("member")
  })
})

describe("deriveUserId", () => {
  it("is stable for the same tenant and user", () => {
    expect(deriveUserId("nexoro", "u-42")).toBe(deriveUserId("nexoro", "u-42"))
  })

  it("namespaces by workspace, so two tenants never collide", () => {
    // Both frontends numbering their users from 1 must not map to one ALG user.
    expect(deriveUserId("kunde-a", "1")).not.toBe(deriveUserId("kunde-b", "1"))
  })

  it("produces a well-formed uuid", () => {
    const id = deriveUserId("nexoro", "u-42")
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
