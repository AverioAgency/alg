import { safeFetch, type SafeFetchOptions, type SafeResponse } from "../http/safe-fetch.js"
import { crawlDelayFor, isAllowed, parseRobotsTxt, type RobotsTxt } from "./robots.js"

/**
 * Polite HTTP client for the signal providers.
 *
 * Three things it guarantees, in order of how badly their absence would hurt:
 *   - robots.txt is fetched once per host and honoured
 *   - at most one request per host at a time, with a delay between them
 *   - every request goes through safeFetch, so SSRF protection still applies
 *
 * The rate limit is per host rather than global on purpose: crawling fifty
 * different sites concurrently is fine, hammering one of them is not.
 */

export class RobotsDisallowedError extends Error {
  readonly url: string

  constructor(url: string) {
    super(`robots.txt disallows fetching ${url}`)
    this.name = "RobotsDisallowedError"
    this.url = url
  }
}

export interface CrawlerOptions {
  userAgent: string
  /** Minimum gap between two requests to the same host. */
  minDelayMs?: number
  /** Upper bound for a Crawl-delay a site asks for, so one site cannot stall a run. */
  maxCrawlDelayMs?: number
  timeoutMs?: number
  maxBytes?: number
  /** How long a parsed robots.txt stays valid. */
  robotsTtlMs?: number
  fetchImpl?: typeof safeFetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

interface HostState {
  robots: RobotsTxt | null
  robotsFetchedAt: number
  /** Timestamp of the last request, for spacing the next one. */
  lastRequestAt: number
  /** Serializes requests to this host. */
  queue: Promise<unknown>
}

const DEFAULTS = {
  minDelayMs: 1000,
  maxCrawlDelayMs: 10_000,
  timeoutMs: 15_000,
  maxBytes: 2 * 1024 * 1024,
  robotsTtlMs: 60 * 60 * 1000,
}

export class Crawler {
  private readonly hosts = new Map<string, HostState>()
  private readonly options: Required<Omit<CrawlerOptions, "fetchImpl" | "sleep" | "now">> & {
    fetchImpl: typeof safeFetch
    sleep: (ms: number) => Promise<void>
    now: () => number
  }

  constructor(options: CrawlerOptions) {
    this.options = {
      userAgent: options.userAgent,
      minDelayMs: options.minDelayMs ?? DEFAULTS.minDelayMs,
      maxCrawlDelayMs: options.maxCrawlDelayMs ?? DEFAULTS.maxCrawlDelayMs,
      timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
      maxBytes: options.maxBytes ?? DEFAULTS.maxBytes,
      robotsTtlMs: options.robotsTtlMs ?? DEFAULTS.robotsTtlMs,
      fetchImpl: options.fetchImpl ?? safeFetch,
      sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      now: options.now ?? (() => Date.now()),
    }
  }

  /**
   * Fetches a URL after checking robots.txt and waiting out the host's delay.
   * Throws RobotsDisallowedError rather than returning an empty result, so a
   * provider can record "not allowed" instead of "no data found".
   */
  async fetch(rawUrl: string, options: Partial<SafeFetchOptions> = {}): Promise<SafeResponse> {
    const url = new URL(rawUrl)
    const host = url.host

    const state = this.hostState(host)

    // Serialize per host: chaining onto the existing promise means two providers
    // crawling the same site queue up instead of firing simultaneously.
    const task = state.queue.then(async () => {
      const robots = await this.robotsFor(url)

      if (robots && !isAllowed(robots, this.options.userAgent, url.pathname + url.search)) {
        throw new RobotsDisallowedError(rawUrl)
      }

      await this.waitForSlot(state, robots)

      const response = await this.options.fetchImpl(rawUrl, {
        userAgent: this.options.userAgent,
        timeoutMs: this.options.timeoutMs,
        maxBytes: this.options.maxBytes,
        ...options,
      })

      state.lastRequestAt = this.options.now()
      return response
    })

    // Keep the chain alive even when this request fails, or one error would
    // block every later request to the host.
    state.queue = task.then(
      () => undefined,
      () => undefined
    )

    return task
  }

  /** Fetches robots.txt once per host and caches the result. */
  private async robotsFor(url: URL): Promise<RobotsTxt | null> {
    const state = this.hostState(url.host)
    const age = this.options.now() - state.robotsFetchedAt

    if (state.robots !== null && age < this.options.robotsTtlMs) {
      return state.robots
    }

    try {
      const response = await this.options.fetchImpl(`${url.protocol}//${url.host}/robots.txt`, {
        userAgent: this.options.userAgent,
        timeoutMs: this.options.timeoutMs,
        // robots.txt is small; a multi-megabyte one is not worth reading.
        maxBytes: 512 * 1024,
      })

      // 4xx means no robots.txt, which per RFC means everything is allowed.
      // A 5xx is ambiguous, and the conservative reading is to stay out.
      if (response.status >= 500) {
        state.robots = {
          groups: [{ userAgents: ["*"], rules: [{ type: "disallow", path: "/" }] }],
          sitemaps: [],
        }
      } else if (response.status >= 400) {
        state.robots = { groups: [], sitemaps: [] }
      } else {
        state.robots = parseRobotsTxt(response.body)
      }
    } catch {
      // Unreachable robots.txt is treated like a missing one: the site itself
      // will fail the next request anyway if it is really down.
      state.robots = { groups: [], sitemaps: [] }
    }

    state.robotsFetchedAt = this.options.now()
    // Deliberately does not touch lastRequestAt: the delay belongs between two
    // page fetches. Counting the robots.txt request would make every host's
    // first real request wait for nothing.
    return state.robots
  }

  private async waitForSlot(state: HostState, robots: RobotsTxt | null): Promise<void> {
    const requested = robots ? crawlDelayFor(robots, this.options.userAgent) : null
    const delay = Math.min(
      Math.max(this.options.minDelayMs, (requested ?? 0) * 1000),
      this.options.maxCrawlDelayMs
    )

    const elapsed = this.options.now() - state.lastRequestAt
    if (elapsed < delay) {
      await this.options.sleep(delay - elapsed)
    }
  }

  private hostState(host: string): HostState {
    let state = this.hosts.get(host)
    if (!state) {
      state = {
        robots: null,
        robotsFetchedAt: 0,
        // Zero rather than now(): the first request to a host should not wait.
        lastRequestAt: 0,
        queue: Promise.resolve(),
      }
      this.hosts.set(host, state)
    }
    return state
  }

  /** Test seam: forget cached robots.txt and timing. */
  reset(): void {
    this.hosts.clear()
  }
}
