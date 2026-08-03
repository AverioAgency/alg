import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

/**
 * Outbound HTTP with SSRF protection.
 *
 * Every request ALG makes to a third-party URL goes through here. The threat is
 * concrete: discovery sources and, from M2, crawled websites supply URLs we then
 * fetch. Without these checks a redirect to http://169.254.169.254/ or to an
 * internal service would let a remote party read the host's metadata or reach
 * Redis and Postgres.
 *
 * Defences, all of which must hold:
 *   - scheme restricted to http/https
 *   - every hostname resolved and each resulting IP checked against private,
 *     loopback, link-local and reserved ranges - re-checked on every redirect,
 *     because only the first hop is under our control
 *   - redirect count capped, request timed out, response size capped
 */

export class SsrfBlockedError extends Error {
  constructor(reason: string) {
    super(`Blocked outbound request: ${reason}`)
    this.name = "SsrfBlockedError"
  }
}

export class ResponseTooLargeError extends Error {
  constructor(limit: number) {
    super(`Response exceeded the ${limit} byte cap`)
    this.name = "ResponseTooLargeError"
  }
}

export interface SafeFetchOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  /** Whole-request budget, redirects included. */
  timeoutMs?: number
  maxRedirects?: number
  maxBytes?: number
  /** Identifies the crawler; comes from ALG_USER_AGENT. */
  userAgent?: string
  signal?: AbortSignal
  /** Test seam. Production resolves through DNS. */
  resolveHost?: (hostname: string) => Promise<string[]>
}

const DEFAULTS = {
  timeoutMs: 15_000,
  maxRedirects: 3,
  maxBytes: 5 * 1024 * 1024,
}

/**
 * Ranges that must never be reachable from a user-influenced URL.
 * Checked against resolved addresses, not against the hostname.
 */
function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number)
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true
  }
  const [a = 0, b = 0] = parts

  if (a === 0) return true // "this network"
  if (a === 10) return true // RFC1918
  if (a === 127) return true // loopback
  if (a === 169 && b === 254) return true // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true // RFC1918
  if (a === 192 && b === 168) return true // RFC1918
  if (a === 192 && b === 0) return true // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  if (a >= 224) return true // multicast, reserved, broadcast
  return false
}

function isBlockedIpv6(ip: string): boolean {
  const value = ip.toLowerCase().split("%")[0] ?? ""

  if (value === "::" || value === "::1") return true // unspecified, loopback
  if (value.startsWith("fe80")) return true // link-local
  if (value.startsWith("fc") || value.startsWith("fd")) return true // unique local
  if (value.startsWith("ff")) return true // multicast

  // IPv4-mapped (::ffff:10.0.0.1) must be judged by the embedded IPv4 address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value)
  if (mapped?.[1]) return isBlockedIpv4(mapped[1])

  return false
}

export function isBlockedAddress(ip: string): boolean {
  const version = isIP(ip)
  if (version === 4) return isBlockedIpv4(ip)
  if (version === 6) return isBlockedIpv6(ip)
  return true // not a parsable address - refuse rather than guess
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  // A literal address needs no lookup, but still needs checking.
  if (isIP(hostname) !== 0) return [hostname]
  const records = await lookup(hostname, { all: true, verbatim: true })
  return records.map((r) => r.address)
}

/** Throws unless every address the hostname resolves to is publicly routable. */
export async function assertPublicHost(
  hostname: string,
  resolveHost: (hostname: string) => Promise<string[]> = defaultResolveHost
): Promise<void> {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase()

  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    throw new SsrfBlockedError(`hostname "${hostname}" is loopback`)
  }
  // Docker service names and other single-label hosts resolve to internal
  // containers; nothing on the public internet looks like that.
  if (!normalized.includes(".") && isIP(normalized) === 0) {
    throw new SsrfBlockedError(`hostname "${hostname}" is not fully qualified`)
  }

  let addresses: string[]
  try {
    addresses = await resolveHost(normalized)
  } catch {
    throw new SsrfBlockedError(`hostname "${hostname}" does not resolve`)
  }

  if (addresses.length === 0) {
    throw new SsrfBlockedError(`hostname "${hostname}" resolved to no addresses`)
  }

  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      throw new SsrfBlockedError(`hostname "${hostname}" resolves to non-public ${address}`)
    }
  }
}

export interface SafeResponse {
  status: number
  headers: Headers
  body: string
  url: string
}

/**
 * Fetches a URL with the protections above. Redirects are followed manually so
 * each hop can be validated - `redirect: "follow"` would let the runtime chase a
 * redirect into a private range without us ever seeing it.
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {}
): Promise<SafeResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs
  const maxRedirects = options.maxRedirects ?? DEFAULTS.maxRedirects
  const maxBytes = options.maxBytes ?? DEFAULTS.maxBytes
  const resolveHost = options.resolveHost ?? defaultResolveHost

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onExternalAbort = () => controller.abort()
  options.signal?.addEventListener("abort", onExternalAbort, { once: true })

  try {
    let currentUrl = rawUrl
    let redirects = 0

    for (;;) {
      let url: URL
      try {
        url = new URL(currentUrl)
      } catch {
        throw new SsrfBlockedError(`"${currentUrl}" is not a valid URL`)
      }

      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new SsrfBlockedError(`scheme "${url.protocol}" is not allowed`)
      }

      await assertPublicHost(url.hostname, resolveHost)

      const response = await fetch(url, {
        method: options.method ?? "GET",
        headers: {
          "user-agent": options.userAgent ?? "AlgBot/1.0 (+https://averio.agency/bot)",
          accept: "*/*",
          ...options.headers,
        },
        body: options.body,
        redirect: "manual",
        signal: controller.signal,
      })

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location")
        if (!location) {
          throw new SsrfBlockedError(`redirect ${response.status} without a location header`)
        }
        if (redirects >= maxRedirects) {
          throw new SsrfBlockedError(`exceeded ${maxRedirects} redirects`)
        }
        redirects++
        // Resolve relative redirects against the current URL, then re-validate.
        currentUrl = new URL(location, url).toString()
        continue
      }

      const declared = Number(response.headers.get("content-length") ?? "0")
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new ResponseTooLargeError(maxBytes)
      }

      const body = await readCapped(response, maxBytes)

      return { status: response.status, headers: response.headers, body, url: url.toString() }
    }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", onExternalAbort)
  }
}

/**
 * Reads the body while enforcing the cap as bytes arrive - a lying or absent
 * content-length must not let an unbounded response exhaust memory.
 */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return ""

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new ResponseTooLargeError(maxBytes)
      }
      chunks.push(value)
    }
  }

  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }

  return new TextDecoder().decode(merged)
}
