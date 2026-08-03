import { describe, expect, it, vi } from "vitest"
import { Crawler } from "@alg/core"
import { type Entity, type RunContext } from "@alg/shared"
import { createWebPresenceProvider } from "../provider.js"

/**
 * The www fallback here comes from a real run: keintzel.at has no A record while
 * www.keintzel.at does, so the provider reported "unreachable" for a site that
 * was plainly online.
 */

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

function ctx(): RunContext {
  return {
    workspaceId: "11111111-1111-1111-1111-111111111111",
    runId: "22222222-2222-2222-2222-222222222222",
    signal: new AbortController().signal,
    logger,
  }
}

function entity(overrides: Partial<Entity> = {}): Entity {
  return {
    id: "33333333-3333-3333-3333-333333333333",
    workspaceId: "11111111-1111-1111-1111-111111111111",
    targetType: "local_business",
    name: "Muster GmbH",
    domain: "muster.at",
    signals: {},
    ...overrides,
  }
}

/** Serves only the hosts listed; everything else fails DNS the way safeFetch does. */
function fakeFetch(available: Record<string, { status?: number; body?: string }>) {
  return vi.fn(async (url: string) => {
    const parsed = new URL(url)
    const route = available[parsed.host]

    if (!route) {
      throw new Error(`Blocked outbound request: hostname "${parsed.host}" does not resolve`)
    }
    // robots.txt is served permissively unless the fixture says otherwise.
    if (parsed.pathname === "/robots.txt") {
      return { status: 200, headers: new Headers(), body: "", url }
    }
    return {
      status: route.status ?? 200,
      headers: new Headers(),
      body: route.body ?? "<html></html>",
      url,
    }
  })
}

function providerWith(fetchImpl: ReturnType<typeof fakeFetch>) {
  const crawler = new Crawler({
    userAgent: "AlgBot/1.0",
    fetchImpl: fetchImpl as never,
    sleep: async () => undefined,
    minDelayMs: 0,
  })
  return createWebPresenceProvider({ crawler })
}

describe("web.presence", () => {
  it("reports no website when there is no domain", async () => {
    // The "no website" lead is the whole premise of the website-selling case,
    // so it has to be a value rather than an error.
    const provider = providerWith(fakeFetch({}))
    const result = await provider.run(entity({ domain: null, website: null }), ctx())

    expect(result.values["web.presence.has_website"]).toBe(false)
    expect(result.values["web.presence.reachable"]).toBe(false)
  })

  it("reads a reachable site", async () => {
    const provider = providerWith(fakeFetch({ "muster.at": {} }))
    const result = await provider.run(entity(), ctx())

    expect(result.values["web.presence.has_website"]).toBe(true)
    expect(result.values["web.presence.reachable"]).toBe(true)
    expect(result.values["web.presence.https"]).toBe(true)
  })

  it("falls back to www when the bare domain does not resolve", async () => {
    // Exactly the keintzel.at case: normalization strips www for deduplication,
    // but the site only answers with it.
    const fetchImpl = fakeFetch({ "www.muster.at": {} })
    const provider = providerWith(fetchImpl)

    const result = await provider.run(entity(), ctx())

    expect(result.values["web.presence.reachable"]).toBe(true)
    expect(String(result.values["web.presence.final_url"])).toContain("www.muster.at")
    expect(result.error).toBeUndefined()
  })

  it("prefers the bare domain when both resolve", async () => {
    const fetchImpl = fakeFetch({ "muster.at": {}, "www.muster.at": {} })
    const provider = providerWith(fetchImpl)

    const result = await provider.run(entity(), ctx())

    expect(String(result.values["web.presence.final_url"])).toBe("https://muster.at/")
  })

  it("reports a domain that resolves nowhere as unreachable, not absent", async () => {
    // "Domain recorded but dead" and "no domain at all" are different findings.
    const provider = providerWith(fakeFetch({}))
    const result = await provider.run(entity(), ctx())

    expect(result.values["web.presence.has_website"]).toBe(true)
    expect(result.values["web.presence.reachable"]).toBe(false)
    expect(result.error).toContain("does not resolve")
  })

  it("records a 404 as reachable-but-erroring rather than absent", async () => {
    const provider = providerWith(fakeFetch({ "muster.at": { status: 404 } }))
    const result = await provider.run(entity(), ctx())

    expect(result.values["web.presence.has_website"]).toBe(true)
    expect(result.values["web.presence.reachable"]).toBe(false)
    expect(result.values["web.presence.status_code"]).toBe(404)
  })

  it("derives the domain from the website when none is stored", async () => {
    const provider = providerWith(fakeFetch({ "muster.at": {} }))
    const result = await provider.run(
      entity({ domain: null, website: "https://www.muster.at/kontakt" }),
      ctx()
    )

    expect(result.values["web.presence.reachable"]).toBe(true)
  })

  it("stops when the run is aborted", async () => {
    const fetchImpl = fakeFetch({ "muster.at": {} })
    const provider = providerWith(fetchImpl)
    const controller = new AbortController()
    controller.abort()

    const result = await provider.run(entity(), {
      ...ctx(),
      signal: controller.signal,
    })

    expect(result.values["web.presence.reachable"]).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
