/**
 * robots.txt parsing and evaluation.
 *
 * ALG identifies itself with a real User-Agent and honours what a site asks for.
 * That is a hard requirement, not a courtesy: crawling a Disallow path is how a
 * crawler earns an IP ban, and the whole point of the signal layer is to keep
 * running tomorrow.
 *
 * Implements the parts of RFC 9309 that matter here - group matching, longest
 * match wins, Allow beats Disallow on equal length, Crawl-delay.
 */

export interface RobotsRule {
  type: "allow" | "disallow"
  path: string
}

export interface RobotsGroup {
  userAgents: string[]
  rules: RobotsRule[]
  crawlDelaySeconds?: number
}

export interface RobotsTxt {
  groups: RobotsGroup[]
  sitemaps: string[]
}

export function parseRobotsTxt(content: string): RobotsTxt {
  const groups: RobotsGroup[] = []
  const sitemaps: string[] = []

  let current: RobotsGroup | null = null
  // Consecutive User-agent lines share one rule block, per RFC 9309.
  let lastLineWasUserAgent = false

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.split("#")[0]?.trim() ?? ""
    if (line.length === 0) continue

    const separator = line.indexOf(":")
    if (separator === -1) continue

    const field = line.slice(0, separator).trim().toLowerCase()
    const value = line.slice(separator + 1).trim()

    switch (field) {
      case "user-agent": {
        if (!current || !lastLineWasUserAgent) {
          current = { userAgents: [], rules: [] }
          groups.push(current)
        }
        current.userAgents.push(value.toLowerCase())
        lastLineWasUserAgent = true
        break
      }
      case "allow":
      case "disallow": {
        if (!current) break
        // An empty Disallow means "nothing is disallowed" and is simply skipped.
        if (field === "disallow" && value === "") {
          lastLineWasUserAgent = false
          break
        }
        current.rules.push({ type: field, path: value })
        lastLineWasUserAgent = false
        break
      }
      case "crawl-delay": {
        if (!current) break
        const delay = Number(value)
        if (Number.isFinite(delay) && delay >= 0) current.crawlDelaySeconds = delay
        lastLineWasUserAgent = false
        break
      }
      case "sitemap": {
        if (value) sitemaps.push(value)
        lastLineWasUserAgent = false
        break
      }
      default:
        lastLineWasUserAgent = false
    }
  }

  return { groups, sitemaps }
}

/**
 * Finds the group that applies to a user agent.
 *
 * A specific match wins over the wildcard, which is what lets a site allow
 * Googlebot and block everyone else - we must land in the "everyone else" group,
 * not in Googlebot's.
 */
export function groupFor(robots: RobotsTxt, userAgent: string): RobotsGroup | null {
  const token = userAgentToken(userAgent)

  let wildcard: RobotsGroup | null = null
  let specific: RobotsGroup | null = null

  for (const group of robots.groups) {
    for (const agent of group.userAgents) {
      if (agent === "*") {
        wildcard ??= group
      } else if (token.includes(agent) || agent.includes(token)) {
        specific ??= group
      }
    }
  }

  return specific ?? wildcard
}

/** "AlgBot/1.0 (+https://...)" -> "algbot" */
function userAgentToken(userAgent: string): string {
  return (userAgent.split("/")[0] ?? userAgent).trim().toLowerCase()
}

/**
 * Decides whether a path may be fetched.
 *
 * Longest matching rule wins; on equal length Allow beats Disallow, which is what
 * makes the common "Disallow: /wp-admin/ + Allow: /wp-admin/admin-ajax.php"
 * pattern work.
 */
export function isAllowed(robots: RobotsTxt, userAgent: string, path: string): boolean {
  const group = groupFor(robots, userAgent)
  if (!group || group.rules.length === 0) return true

  let best: { rule: RobotsRule; length: number } | null = null

  for (const rule of group.rules) {
    if (!matchesPattern(rule.path, path)) continue
    const length = rule.path.length

    if (!best || length > best.length || (length === best.length && rule.type === "allow")) {
      best = { rule, length }
    }
  }

  return best ? best.rule.type === "allow" : true
}

/** Supports the * and $ wildcards robots.txt allows. */
function matchesPattern(pattern: string, path: string): boolean {
  if (pattern === "") return false
  if (!pattern.includes("*") && !pattern.includes("$")) {
    return path.startsWith(pattern)
  }

  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\\\$$/, "$")
    .replace(/\*/g, ".*")

  const anchored = pattern.endsWith("$") ? `^${escaped}` : `^${escaped}`
  try {
    return new RegExp(anchored).test(path)
  } catch {
    // A malformed pattern must not block the crawl; treat it as no match.
    return false
  }
}

export function crawlDelayFor(robots: RobotsTxt, userAgent: string): number | null {
  return groupFor(robots, userAgent)?.crawlDelaySeconds ?? null
}
