import { describe, expect, it } from "vitest"
import { createCorsMiddleware } from "../middleware/cors.js"

/**
 * CORS is a browser-side guard, so what matters is which headers leave this
 * process. The important cases are the ones where no allow header may appear.
 */

interface Captured {
  headers: Record<string, string>
  status?: number
  ended: boolean
  passedThrough: boolean
}

function call(origins: string, request: { method?: string; origin?: string }): Captured {
  const captured: Captured = { headers: {}, ended: false, passedThrough: false }

  const req = {
    method: request.method ?? "GET",
    header: (name: string): string | undefined =>
      name.toLowerCase() === "origin" ? request.origin : undefined,
  }

  const res = {
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value
      return this
    },
    appendHeader(name: string, value: string) {
      const key = name.toLowerCase()
      captured.headers[key] = captured.headers[key] ? `${captured.headers[key]}, ${value}` : value
      return this
    },
    status(code: number) {
      captured.status = code
      return this
    },
    end() {
      captured.ended = true
      return this
    },
  }

  createCorsMiddleware({ origins })(req as never, res as never, () => {
    captured.passedThrough = true
  })

  return captured
}

const ALLOWED = "https://nexoro.net,https://*.nexoro.net"

describe("allowed origins", () => {
  it("echoes the origin back rather than a wildcard", () => {
    // Credentials are involved, and browsers refuse "*" in that case.
    const result = call(ALLOWED, { origin: "https://kunde.nexoro.net" })

    expect(result.headers["access-control-allow-origin"]).toBe("https://kunde.nexoro.net")
    expect(result.headers["access-control-allow-credentials"]).toBe("true")
  })

  it("sets Vary: Origin, so a cache cannot serve one tenant's header to another", () => {
    const result = call(ALLOWED, { origin: "https://kunde.nexoro.net" })
    expect(result.headers["vary"]).toContain("Origin")
  })

  it("exposes the headers a well-behaved client reads", () => {
    const result = call(ALLOWED, { origin: "https://nexoro.net" })
    expect(result.headers["access-control-expose-headers"]).toContain("x-request-id")
    expect(result.headers["access-control-expose-headers"]).toContain("retry-after")
  })

  it("answers a preflight itself", () => {
    const result = call(ALLOWED, { method: "OPTIONS", origin: "https://kunde.nexoro.net" })

    expect(result.status).toBe(204)
    expect(result.ended).toBe(true)
    expect(result.passedThrough).toBe(false)
    expect(result.headers["access-control-allow-headers"]).toContain("x-workspace-id")
    expect(result.headers["access-control-allow-methods"]).toContain("PATCH")
  })
})

describe("origins that are not allowed", () => {
  it("sends no allow header", () => {
    const result = call(ALLOWED, { origin: "https://evil.example.com" })
    expect(result.headers["access-control-allow-origin"]).toBeUndefined()
  })

  it("lets the request continue rather than rejecting it", () => {
    // The browser blocks the response; returning 403 here would break server
    // callers that happen to send an Origin, and would tell a prober which
    // origins are configured.
    const result = call(ALLOWED, { origin: "https://evil.example.com" })
    expect(result.passedThrough).toBe(true)
    expect(result.status).toBeUndefined()
  })

  it("does not fall for a lookalike host", () => {
    expect(
      call(ALLOWED, { origin: "https://evil-nexoro.net" }).headers["access-control-allow-origin"]
    ).toBeUndefined()
    expect(
      call(ALLOWED, { origin: "https://nexoro.net.evil.com" }).headers[
        "access-control-allow-origin"
      ]
    ).toBeUndefined()
  })

  it("requires the scheme to match", () => {
    expect(
      call(ALLOWED, { origin: "http://kunde.nexoro.net" }).headers["access-control-allow-origin"]
    ).toBeUndefined()
  })
})

describe("requests without an Origin", () => {
  it("passes through untouched", () => {
    // curl, the PHP backend, a health probe: CORS does not apply, and adding
    // headers would only confuse caches.
    const result = call(ALLOWED, {})

    expect(result.passedThrough).toBe(true)
    expect(Object.keys(result.headers)).toStrictEqual([])
  })
})

describe("the default configuration", () => {
  it("allows no browser at all", () => {
    // ALG serves lead data under GDPR. Empty must mean closed, not open.
    const result = call("", { origin: "https://nexoro.net" })
    expect(result.headers["access-control-allow-origin"]).toBeUndefined()
  })

  it("ignores a wildcard in the configuration", () => {
    // A config typo must not open an authenticated API to every page online.
    const result = call("*", { origin: "https://anything.example.com" })
    expect(result.headers["access-control-allow-origin"]).toBeUndefined()
  })
})
