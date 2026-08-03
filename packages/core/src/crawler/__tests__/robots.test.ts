import { describe, expect, it } from "vitest"
import { crawlDelayFor, groupFor, isAllowed, parseRobotsTxt } from "../robots.js"

const UA = "AlgBot/1.0 (+https://averio.agency/bot)"

describe("parseRobotsTxt", () => {
  it("parses a typical file", () => {
    const robots = parseRobotsTxt(`
User-agent: *
Disallow: /admin/
Disallow: /private
Allow: /admin/public
Crawl-delay: 2

Sitemap: https://example.at/sitemap.xml
`)

    expect(robots.groups).toHaveLength(1)
    expect(robots.groups[0]?.rules).toHaveLength(3)
    expect(robots.groups[0]?.crawlDelaySeconds).toBe(2)
    expect(robots.sitemaps).toStrictEqual(["https://example.at/sitemap.xml"])
  })

  it("ignores comments and blank lines", () => {
    const robots = parseRobotsTxt(`
# nothing to see
User-agent: *   # inline comment
Disallow: /x
`)
    expect(robots.groups[0]?.rules).toStrictEqual([{ type: "disallow", path: "/x" }])
  })

  it("groups consecutive user-agent lines together", () => {
    // Per RFC 9309 these share one rule block.
    const robots = parseRobotsTxt(`
User-agent: googlebot
User-agent: bingbot
Disallow: /search
`)
    expect(robots.groups).toHaveLength(1)
    expect(robots.groups[0]?.userAgents).toStrictEqual(["googlebot", "bingbot"])
  })

  it("starts a new group after a rule", () => {
    const robots = parseRobotsTxt(`
User-agent: googlebot
Disallow: /a

User-agent: *
Disallow: /b
`)
    expect(robots.groups).toHaveLength(2)
  })

  it("treats an empty Disallow as no restriction", () => {
    const robots = parseRobotsTxt("User-agent: *\nDisallow:")
    expect(robots.groups[0]?.rules).toStrictEqual([])
    expect(isAllowed(robots, UA, "/anything")).toBe(true)
  })

  it("survives a malformed file", () => {
    expect(() => parseRobotsTxt("this is not robots.txt at all")).not.toThrow()
    expect(parseRobotsTxt("").groups).toStrictEqual([])
  })
})

describe("groupFor", () => {
  it("prefers a specific group over the wildcard", () => {
    // A site that allows Googlebot and blocks everyone else must land us in the
    // "everyone else" group, not in Googlebot's.
    const robots = parseRobotsTxt(`
User-agent: googlebot
Disallow:

User-agent: *
Disallow: /
`)

    expect(isAllowed(robots, UA, "/anything")).toBe(false)
  })

  it("matches our own name when a site addresses it", () => {
    const robots = parseRobotsTxt(`
User-agent: *
Disallow: /

User-agent: AlgBot
Disallow:
`)

    expect(isAllowed(robots, UA, "/kontakt")).toBe(true)
  })

  it("falls back to the wildcard when nothing matches", () => {
    const robots = parseRobotsTxt("User-agent: *\nDisallow: /admin")
    expect(groupFor(robots, UA)?.userAgents).toStrictEqual(["*"])
  })
})

describe("isAllowed", () => {
  it("allows everything when there are no rules", () => {
    expect(isAllowed(parseRobotsTxt(""), UA, "/impressum")).toBe(true)
  })

  it("blocks a disallowed prefix", () => {
    const robots = parseRobotsTxt("User-agent: *\nDisallow: /admin/")
    expect(isAllowed(robots, UA, "/admin/users")).toBe(false)
    expect(isAllowed(robots, UA, "/impressum")).toBe(true)
  })

  it("lets the longest match win", () => {
    const robots = parseRobotsTxt(`
User-agent: *
Disallow: /
Allow: /impressum
`)
    expect(isAllowed(robots, UA, "/impressum")).toBe(true)
    expect(isAllowed(robots, UA, "/anything-else")).toBe(false)
  })

  it("lets Allow win on an equally long match", () => {
    const robots = parseRobotsTxt(`
User-agent: *
Disallow: /page
Allow: /page
`)
    expect(isAllowed(robots, UA, "/page")).toBe(true)
  })

  it("handles the common WordPress pattern", () => {
    const robots = parseRobotsTxt(`
User-agent: *
Disallow: /wp-admin/
Allow: /wp-admin/admin-ajax.php
`)
    expect(isAllowed(robots, UA, "/wp-admin/options.php")).toBe(false)
    expect(isAllowed(robots, UA, "/wp-admin/admin-ajax.php")).toBe(true)
  })

  it("supports the * wildcard", () => {
    const robots = parseRobotsTxt("User-agent: *\nDisallow: /*.pdf")
    expect(isAllowed(robots, UA, "/files/report.pdf")).toBe(false)
    expect(isAllowed(robots, UA, "/files/report.html")).toBe(true)
  })

  it("supports the $ anchor", () => {
    const robots = parseRobotsTxt("User-agent: *\nDisallow: /*.php$")
    expect(isAllowed(robots, UA, "/index.php")).toBe(false)
    expect(isAllowed(robots, UA, "/index.php?x=1")).toBe(true)
  })

  it("does not block on a malformed pattern", () => {
    const robots = parseRobotsTxt("User-agent: *\nDisallow: /[unclosed")
    expect(() => isAllowed(robots, UA, "/anything")).not.toThrow()
  })
})

describe("crawlDelayFor", () => {
  it("reads the delay from the applicable group", () => {
    const robots = parseRobotsTxt("User-agent: *\nCrawl-delay: 5\nDisallow: /x")
    expect(crawlDelayFor(robots, UA)).toBe(5)
  })

  it("returns null when none is set", () => {
    expect(crawlDelayFor(parseRobotsTxt("User-agent: *\nDisallow: /x"), UA)).toBeNull()
  })
})
