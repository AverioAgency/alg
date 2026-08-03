import { describe, expect, it } from "vitest"
import {
  isOriginAllowed,
  isValidWorkspaceSlug,
  parseAllowedOrigins,
  tenantSlugFromHost,
} from "../tenant.js"

/**
 * A hostname is attacker-controlled input: anyone can send any Host header, and
 * a misconfigured proxy forwards it. Since the slug it produces names a tenant,
 * most of these tests are about what must be refused.
 */

const DOMAIN = "nexoro.net"

describe("tenantSlugFromHost", () => {
  it("reads the subdomain as the slug", () => {
    expect(tenantSlugFromHost("nexoro.nexoro.net", DOMAIN).slug).toBe("nexoro")
    expect(tenantSlugFromHost("kunde-a.nexoro.net", DOMAIN).slug).toBe("kunde-a")
  })

  it("ignores the port a Host header carries", () => {
    expect(tenantSlugFromHost("nexoro.nexoro.net:3000", DOMAIN).slug).toBe("nexoro")
  })

  it("is case-insensitive", () => {
    expect(tenantSlugFromHost("NEXORO.Nexoro.NET", DOMAIN).slug).toBe("nexoro")
  })

  it("refuses a nested subdomain", () => {
    // The attack this blocks: nexoro.evil.nexoro.net reads as the "nexoro"
    // tenant to a careless implementation, while the attacker controls evil.
    const result = tenantSlugFromHost("nexoro.evil.nexoro.net", DOMAIN)
    expect(result.slug).toBeNull()
    expect(result.reason).toBe("nested_subdomain")
  })

  it("refuses a lookalike domain", () => {
    // evil-nexoro.net ends with "nexoro.net" as a string but is a different
    // domain - the leading dot in the suffix check is what stops it.
    expect(tenantSlugFromHost("kunde.evil-nexoro.net", DOMAIN).reason).toBe("wrong_domain")
    expect(tenantSlugFromHost("nexoro.net.evil.com", DOMAIN).reason).toBe("wrong_domain")
  })

  it("refuses the bare domain", () => {
    expect(tenantSlugFromHost("nexoro.net", DOMAIN).reason).toBe("not_a_subdomain")
  })

  it("refuses reserved names", () => {
    // A workspace called "www" or "admin" is either a typo or an attempt.
    for (const reserved of ["www", "api", "admin", "auth", "docs"]) {
      expect(tenantSlugFromHost(`${reserved}.nexoro.net`, DOMAIN).reason).toBe("reserved")
    }
  })

  it("refuses anything that is not a plain label", () => {
    for (const host of [
      "-kunde.nexoro.net",
      "kunde-.nexoro.net",
      "kun_de.nexoro.net",
      "kunde%2e.nexoro.net",
      `${"x".repeat(40)}.nexoro.net`,
    ]) {
      expect(tenantSlugFromHost(host, DOMAIN).slug).toBeNull()
    }
  })

  it("refuses when no tenant domain is configured", () => {
    // Empty configuration must disable the feature, never match everything.
    expect(tenantSlugFromHost("nexoro.nexoro.net", "").slug).toBeNull()
  })

  it("refuses a missing host", () => {
    expect(tenantSlugFromHost(undefined, DOMAIN).reason).toBe("no_host")
    expect(tenantSlugFromHost("", DOMAIN).reason).toBe("no_host")
  })

  it("takes only the first value when a proxy appends several hosts", () => {
    // Header smuggling: "good.nexoro.net, evil.nexoro.net" must not read as evil.
    expect(tenantSlugFromHost("nexoro.nexoro.net, evil.nexoro.net", DOMAIN).slug).toBe("nexoro")
  })

  it("tolerates a leading dot in the configured domain", () => {
    expect(tenantSlugFromHost("nexoro.nexoro.net", ".nexoro.net").slug).toBe("nexoro")
  })
})

describe("isValidWorkspaceSlug", () => {
  it("accepts a plain label and rejects a reserved one", () => {
    expect(isValidWorkspaceSlug("nexoro")).toBe(true)
    expect(isValidWorkspaceSlug("kunde-42")).toBe(true)
    expect(isValidWorkspaceSlug("admin")).toBe(false)
    expect(isValidWorkspaceSlug("has space")).toBe(false)
  })
})

describe("parseAllowedOrigins", () => {
  it("splits and trims", () => {
    expect(parseAllowedOrigins("https://a.de, https://b.de")).toStrictEqual([
      "https://a.de",
      "https://b.de",
    ])
  })

  it("drops a wildcard entry rather than honouring it", () => {
    // A config typo must not open an authenticated API to every page on the
    // internet. Browsers also refuse "*" together with credentials.
    expect(parseAllowedOrigins("*")).toStrictEqual([])
    expect(parseAllowedOrigins("https://a.de,*")).toStrictEqual(["https://a.de"])
  })

  it("treats empty configuration as no browser access", () => {
    expect(parseAllowedOrigins("")).toStrictEqual([])
    expect(parseAllowedOrigins("  , ,")).toStrictEqual([])
  })
})

describe("isOriginAllowed", () => {
  const allowed = ["https://nexoro.net", "https://*.nexoro.net"]

  it("matches an exact origin", () => {
    expect(isOriginAllowed("https://nexoro.net", allowed)).toBe(true)
  })

  it("matches one wildcard label", () => {
    expect(isOriginAllowed("https://kunde.nexoro.net", allowed)).toBe(true)
  })

  it("does not match several labels under a wildcard", () => {
    expect(isOriginAllowed("https://a.b.nexoro.net", allowed)).toBe(false)
  })

  it("does not match a lookalike host", () => {
    expect(isOriginAllowed("https://evil-nexoro.net", allowed)).toBe(false)
    expect(isOriginAllowed("https://nexoro.net.evil.com", allowed)).toBe(false)
  })

  it("requires the scheme to match", () => {
    // http:// and https:// on the same host are different origins.
    expect(isOriginAllowed("http://kunde.nexoro.net", allowed)).toBe(false)
  })

  it("requires the port to match", () => {
    expect(isOriginAllowed("https://nexoro.net:8443", allowed)).toBe(false)
    expect(isOriginAllowed("http://localhost:3000", ["http://localhost:3000"])).toBe(true)
  })

  it("allows nothing when the list is empty", () => {
    expect(isOriginAllowed("https://nexoro.net", [])).toBe(false)
  })

  it("rejects an empty origin", () => {
    expect(isOriginAllowed("", allowed)).toBe(false)
    expect(isOriginAllowed("   ", allowed)).toBe(false)
  })
})
