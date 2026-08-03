/**
 * Deriving a workspace slug from a hostname.
 *
 * `nexoro.nexoro.net` becomes the slug `nexoro`. That is convenient, and it is
 * also the single most dangerous input in this system: a hostname is attacker
 * controlled - anyone can send any Host header, and a misconfigured proxy will
 * happily forward it.
 *
 * So this module is deliberately strict and does one thing: turn a host into a
 * slug, or refuse. It never decides whether the caller may use that slug. The
 * membership check does that, on every request, as it always has.
 */

/**
 * Subdomains that must never become a tenant.
 *
 * Two reasons. `www` and `api` are infrastructure names a user would type by
 * accident, and a workspace called "www" would silently collect data nobody
 * looks at. The rest are names an attacker would try precisely because they look
 * privileged.
 */
const RESERVED_SLUGS = new Set([
  "www",
  "api",
  "app",
  "admin",
  "root",
  "system",
  "internal",
  "static",
  "assets",
  "cdn",
  "mail",
  "smtp",
  "imap",
  "ftp",
  "ns",
  "ns1",
  "ns2",
  "dns",
  "mx",
  "test",
  "staging",
  "dev",
  "demo",
  "localhost",
  "public",
  "private",
  "auth",
  "login",
  "account",
  "billing",
  "support",
  "status",
  "docs",
  "help",
])

/** Lowercase letters, digits and inner hyphens. Deliberately narrower than DNS allows. */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/

export type TenantRejection =
  "no_host" | "wrong_domain" | "not_a_subdomain" | "nested_subdomain" | "reserved" | "malformed"

export interface TenantResult {
  slug: string | null
  reason?: TenantRejection
}

/**
 * Extracts the workspace slug from a hostname.
 *
 * `tenantDomain` is the suffix the subdomain sits under, e.g. "nexoro.net".
 * Anything not directly beneath it is refused - `a.b.nexoro.net` is not a tenant,
 * because allowing nested labels would make `nexoro.evil.nexoro.net` look like
 * the `nexoro` tenant to a careless reader.
 */
export function tenantSlugFromHost(host: string | undefined, tenantDomain: string): TenantResult {
  if (!tenantDomain) return { slug: null, reason: "wrong_domain" }
  if (!host) return { slug: null, reason: "no_host" }

  // Host headers carry the port, and IPv6 literals carry brackets. Strip both
  // before comparing, or ":3000" ends up inside the slug.
  const cleaned = host.trim().toLowerCase().split(",")[0]?.trim() ?? ""
  const withoutPort = cleaned.startsWith("[")
    ? cleaned.slice(0, cleaned.indexOf("]") + 1)
    : (cleaned.split(":")[0] ?? "")

  const domain = tenantDomain.trim().toLowerCase().replace(/^\./, "")
  const suffix = `.${domain}`

  if (withoutPort === domain) return { slug: null, reason: "not_a_subdomain" }
  if (!withoutPort.endsWith(suffix)) return { slug: null, reason: "wrong_domain" }

  const label = withoutPort.slice(0, -suffix.length)
  if (label.length === 0) return { slug: null, reason: "not_a_subdomain" }
  // One label only: `a.b.nexoro.net` is refused rather than read as "b".
  if (label.includes(".")) return { slug: null, reason: "nested_subdomain" }
  if (!SLUG_RE.test(label)) return { slug: null, reason: "malformed" }
  if (RESERVED_SLUGS.has(label)) return { slug: null, reason: "reserved" }

  return { slug: label }
}

/** True for a slug this system will accept from any source, not just a hostname. */
export function isValidWorkspaceSlug(slug: string): boolean {
  return SLUG_RE.test(slug) && !RESERVED_SLUGS.has(slug)
}

export const RESERVED_WORKSPACE_SLUGS: readonly string[] = [...RESERVED_SLUGS].sort()

/**
 * Parses the CORS allowlist.
 *
 * `*` is dropped rather than honoured. A wildcard cannot be combined with
 * credentials at all (browsers refuse), and on an API serving lead data it would
 * let any page on the internet make authenticated requests on a user's behalf.
 * Silently ignoring it beats a config typo opening the API to everyone.
 */
export function parseAllowedOrigins(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry !== "*")
    .map((entry) => entry.replace(/\/$/, ""))
}

/**
 * Whether an Origin header is allowed.
 *
 * Supports one wildcard label at the front - `https://*.nexoro.net` matches
 * `https://nexoro.nexoro.net` but not `https://a.b.nexoro.net` and not
 * `https://evil-nexoro.net`. Scheme and port must match exactly, because
 * `http://` and `https://` on the same host are different origins.
 */
export function isOriginAllowed(origin: string, allowed: readonly string[]): boolean {
  const candidate = origin.trim().replace(/\/$/, "").toLowerCase()
  if (candidate.length === 0) return false

  for (const entry of allowed) {
    const pattern = entry.toLowerCase()

    if (!pattern.includes("*")) {
      if (pattern === candidate) return true
      continue
    }

    // Only the leading label may be a wildcard: "https://*.example.com".
    const match = /^([a-z][a-z0-9+.-]*:\/\/)\*\.(.+)$/.exec(pattern)
    if (!match) continue

    const [, scheme = "", rest = ""] = match
    if (!candidate.startsWith(scheme)) continue

    const hostPart = candidate.slice(scheme.length)
    if (!hostPart.endsWith(`.${rest}`)) continue

    const label = hostPart.slice(0, -(rest.length + 1))
    // One label, and a real one: this is what stops "a.b" and "" from matching.
    if (label.length > 0 && !label.includes(".")) return true
  }

  return false
}
