import { describe, expect, it, vi } from "vitest"
import { Crawler, RobotsDisallowedError } from "../crawler.js"

const UA = "AlgBot/1.0 (+https://averio.agency/bot)"

/**
 * A controllable clock: the crawler's whole job is to wait between requests, and
 * a test that actually waited would take minutes.
 */
function fakeClock() {
  let current = 1_000_000
  const slept: number[] = []
  return {
    now: () => current,
    sleep: async (ms: number) => {
      slept.push(ms)
      current += ms
    },
    advance: (ms: number) => {
      current += ms
    },
    slept,
  }
}

/** Serves robots.txt and pages from a fixed map. */
function fakeFetch(routes: Record<string, { status?: number; body: string }>) {
  return vi.fn(async (url: string) => {
    const route = routes[url] ?? routes[new URL(url).pathname]
    return {
      status: route?.status ?? (route ? 200 : 404),
      headers: new Headers(),
      body: route?.body ?? "",
      url,
    }
  })
}

describe("Crawler robots enforcement", () => {
  it("fetches robots.txt before the first page", async () => {
    const clock = fakeClock()
    const fetchImpl = fakeFetch({
      "https://muster.at/robots.txt": { body: "User-agent: *\nDisallow: /admin" },
      "https://muster.at/impressum": { body: "<html>Impressum</html>" },
    })

    const crawler = new Crawler({ userAgent: UA, fetchImpl: fetchImpl as never, ...clock })
    await crawler.fetch("https://muster.at/impressum")

    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://muster.at/robots.txt")
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("https://muster.at/impressum")
  })

  it("refuses a disallowed path", async () => {
    const clock = fakeClock()
    const fetchImpl = fakeFetch({
      "https://muster.at/robots.txt": { body: "User-agent: *\nDisallow: /admin" },
    })

    const crawler = new Crawler({ userAgent: UA, fetchImpl: fetchImpl as never, ...clock })

    // Throwing rather than returning empty lets a provider record "not allowed"
    // instead of "no data found" - a meaningful difference in the report.
    await expect(crawler.fetch("https://muster.at/admin/users")).rejects.toBeInstanceOf(
      RobotsDisallowedError
    )
  })

  it("fetches robots.txt only once per host", async () => {
    const clock = fakeClock()
    const fetchImpl = fakeFetch({
      "https://muster.at/robots.txt": { body: "User-agent: *\nDisallow:" },
      "https://muster.at/a": { body: "a" },
      "https://muster.at/b": { body: "b" },
    })

    const crawler = new Crawler({ userAgent: UA, fetchImpl: fetchImpl as never, ...clock })
    await crawler.fetch("https://muster.at/a")
    await crawler.fetch("https://muster.at/b")

    const robotsCalls = fetchImpl.mock.calls.filter((c) => String(c[0]).endsWith("/robots.txt"))
    expect(robotsCalls).toHaveLength(1)
  })

  it("treats a missing robots.txt as permission granted", async () => {
    const clock = fakeClock()
    const fetchImpl = fakeFetch({
      "https://muster.at/robots.txt": { status: 404, body: "" },
      "https://muster.at/impressum": { body: "ok" },
    })

    const crawler = new Crawler({ userAgent: UA, fetchImpl: fetchImpl as never, ...clock })
    await expect(crawler.fetch("https://muster.at/impressum")).resolves.toMatchObject({
      status: 200,
    })
  })

  it("stays out when robots.txt returns a server error", async () => {
    // 5xx is ambiguous; the conservative reading is not to crawl.
    const clock = fakeClock()
    const fetchImpl = fakeFetch({
      "https://muster.at/robots.txt": { status: 503, body: "" },
    })

    const crawler = new Crawler({ userAgent: UA, fetchImpl: fetchImpl as never, ...clock })
    await expect(crawler.fetch("https://muster.at/impressum")).rejects.toBeInstanceOf(
      RobotsDisallowedError
    )
  })

  it("treats an unreachable robots.txt as permission granted", async () => {
    const clock = fakeClock()
    let call = 0
    const fetchImpl = vi.fn(async (url: string) => {
      call++
      if (call === 1) throw new Error("ECONNREFUSED")
      return { status: 200, headers: new Headers(), body: "page", url }
    })

    const crawler = new Crawler({ userAgent: UA, fetchImpl: fetchImpl as never, ...clock })
    await expect(crawler.fetch("https://muster.at/impressum")).resolves.toMatchObject({
      status: 200,
    })
  })
})

describe("Crawler rate limiting", () => {
  it("spaces out requests to the same host", async () => {
    const clock = fakeClock()
    const fetchImpl = fakeFetch({
      "https://muster.at/robots.txt": { body: "" },
      "https://muster.at/a": { body: "a" },
      "https://muster.at/b": { body: "b" },
    })

    const crawler = new Crawler({
      userAgent: UA,
      minDelayMs: 1000,
      fetchImpl: fetchImpl as never,
      ...clock,
    })

    await crawler.fetch("https://muster.at/a")
    await crawler.fetch("https://muster.at/b")

    expect(clock.slept.some((ms) => ms > 0)).toBe(true)
  })

  it("does not delay across different hosts", async () => {
    // Crawling fifty sites concurrently is fine; hammering one is not.
    const clock = fakeClock()
    const fetchImpl = fakeFetch({
      "https://a.at/robots.txt": { body: "" },
      "https://a.at/x": { body: "x" },
      "https://b.at/robots.txt": { body: "" },
      "https://b.at/x": { body: "x" },
    })

    const crawler = new Crawler({
      userAgent: UA,
      minDelayMs: 5000,
      fetchImpl: fetchImpl as never,
      ...clock,
    })

    await crawler.fetch("https://a.at/x")
    const sleptAfterFirst = clock.slept.length
    await crawler.fetch("https://b.at/x")

    expect(clock.slept.length).toBe(sleptAfterFirst)
  })

  it("honours a Crawl-delay the site asks for", async () => {
    const clock = fakeClock()
    const fetchImpl = fakeFetch({
      "https://muster.at/robots.txt": { body: "User-agent: *\nCrawl-delay: 5\nDisallow: /x" },
      "https://muster.at/a": { body: "a" },
      "https://muster.at/b": { body: "b" },
    })

    const crawler = new Crawler({
      userAgent: UA,
      minDelayMs: 1000,
      fetchImpl: fetchImpl as never,
      ...clock,
    })

    await crawler.fetch("https://muster.at/a")
    await crawler.fetch("https://muster.at/b")

    // 5 s requested beats the 1 s default.
    expect(Math.max(...clock.slept)).toBeGreaterThanOrEqual(4000)
  })

  it("caps an unreasonable Crawl-delay", async () => {
    // One site asking for 300 s must not stall a whole run.
    const clock = fakeClock()
    const fetchImpl = fakeFetch({
      "https://muster.at/robots.txt": { body: "User-agent: *\nCrawl-delay: 300\nDisallow: /x" },
      "https://muster.at/a": { body: "a" },
      "https://muster.at/b": { body: "b" },
    })

    const crawler = new Crawler({
      userAgent: UA,
      maxCrawlDelayMs: 10_000,
      fetchImpl: fetchImpl as never,
      ...clock,
    })

    await crawler.fetch("https://muster.at/a")
    await crawler.fetch("https://muster.at/b")

    expect(Math.max(...clock.slept)).toBeLessThanOrEqual(10_000)
  })

  it("does not delay the very first request to a host", async () => {
    const clock = fakeClock()
    const fetchImpl = fakeFetch({
      "https://muster.at/robots.txt": { body: "" },
      "https://muster.at/a": { body: "a" },
    })

    const crawler = new Crawler({
      userAgent: UA,
      minDelayMs: 5000,
      fetchImpl: fetchImpl as never,
      ...clock,
    })

    await crawler.fetch("https://muster.at/a")
    expect(clock.slept.filter((ms) => ms >= 5000)).toHaveLength(0)
  })

  it("keeps serving a host after one request fails", async () => {
    // A single 500 must not block every later request to that host.
    const clock = fakeClock()
    let call = 0
    const fetchImpl = vi.fn(async (url: string) => {
      call++
      if (String(url).endsWith("/robots.txt")) {
        return { status: 200, headers: new Headers(), body: "", url }
      }
      if (call === 2) throw new Error("boom")
      return { status: 200, headers: new Headers(), body: "ok", url }
    })

    const crawler = new Crawler({ userAgent: UA, fetchImpl: fetchImpl as never, ...clock })

    await expect(crawler.fetch("https://muster.at/a")).rejects.toThrow("boom")
    await expect(crawler.fetch("https://muster.at/b")).resolves.toMatchObject({ status: 200 })
  })
})

describe("Crawler passes options through", () => {
  it("sends the configured user agent", async () => {
    const clock = fakeClock()
    const fetchImpl = fakeFetch({
      "https://muster.at/robots.txt": { body: "" },
      "https://muster.at/a": { body: "a" },
    })

    const crawler = new Crawler({ userAgent: UA, fetchImpl: fetchImpl as never, ...clock })
    await crawler.fetch("https://muster.at/a")

    const init = fetchImpl.mock.calls.at(-1)?.[1] as { userAgent: string }
    expect(init.userAgent).toBe(UA)
  })

  it("caps the response size", async () => {
    const clock = fakeClock()
    const fetchImpl = fakeFetch({
      "https://muster.at/robots.txt": { body: "" },
      "https://muster.at/a": { body: "a" },
    })

    const crawler = new Crawler({
      userAgent: UA,
      maxBytes: 1024,
      fetchImpl: fetchImpl as never,
      ...clock,
    })
    await crawler.fetch("https://muster.at/a")

    const init = fetchImpl.mock.calls.at(-1)?.[1] as { maxBytes: number }
    expect(init.maxBytes).toBe(1024)
  })
})
