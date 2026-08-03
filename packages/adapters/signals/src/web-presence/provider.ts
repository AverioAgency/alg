import {
  type Entity,
  type RunContext,
  type SignalBundle,
  type SignalDef,
  type SignalProvider,
  type TargetType,
} from "@alg/shared"
import { type Crawler, RobotsDisallowedError, normalizeDomain } from "@alg/core"

/**
 * Does this company have a working website?
 *
 * The root of the web.* dependency tree: every other web provider needs a page to
 * read, and this one establishes whether there is one. Kept deliberately cheap -
 * a single request, no parsing beyond the status line - because it runs for every
 * entity while the providers above it run only for those that pass.
 *
 * "No website" is a finding, not a failure. It is the entire premise of the
 * website-selling use case, so it has to be recorded as a value rather than an
 * error.
 */

const PROVIDES: SignalDef[] = [
  {
    key: "web.presence.has_website",
    type: "boolean",
    operators: ["eq", "neq", "exists"],
    labelKey: "signal.web.presence.has_website",
  },
  {
    key: "web.presence.reachable",
    type: "boolean",
    operators: ["eq", "neq", "exists"],
    labelKey: "signal.web.presence.reachable",
  },
  {
    key: "web.presence.status_code",
    type: "number",
    operators: ["eq", "neq", "lt", "lte", "gt", "gte", "exists"],
    labelKey: "signal.web.presence.status_code",
  },
  {
    key: "web.presence.https",
    type: "boolean",
    operators: ["eq", "neq", "exists"],
    labelKey: "signal.web.presence.https",
  },
  {
    key: "web.presence.final_url",
    type: "string",
    operators: ["eq", "contains", "exists"],
    labelKey: "signal.web.presence.final_url",
  },
  {
    key: "web.presence.robots_blocked",
    type: "boolean",
    operators: ["eq", "neq", "exists"],
    labelKey: "signal.web.presence.robots_blocked",
  },
]

export interface WebPresenceOptions {
  crawler: Crawler
}

export function createWebPresenceProvider(options: WebPresenceOptions): SignalProvider {
  return {
    id: "web.presence",
    version: "1.0.0",
    provides: PROVIDES,
    dependsOn: [],
    appliesTo: ["local_business", "company"] satisfies TargetType[],
    // One HTTP request; the cost is wall-clock time, not money.
    cost: { unit: "per_entity", amount: 0, currency: "EUR" },
    ttlDays: 30,

    async run(entity: Entity, ctx: RunContext): Promise<SignalBundle> {
      const fetchedAt = new Date().toISOString()
      const provenance = {
        providerId: "web.presence",
        providerVersion: "1.0.0",
        fetchedAt,
      }

      const domain = entity.domain ?? normalizeDomain(entity.website ?? null)

      if (!domain) {
        // Nothing to check. This is the "no website" lead, which is exactly what
        // some users are looking for.
        return {
          values: {
            "web.presence.has_website": false,
            "web.presence.reachable": false,
          },
          provenance,
        }
      }

      const url = `https://${domain}/`

      try {
        const response = await options.crawler.fetch(url, { signal: ctx.signal })
        const finalUrl = response.url

        return {
          values: {
            "web.presence.has_website": true,
            "web.presence.reachable": response.status >= 200 && response.status < 400,
            "web.presence.status_code": response.status,
            "web.presence.https": finalUrl.startsWith("https://"),
            "web.presence.final_url": finalUrl,
            "web.presence.robots_blocked": false,
          },
          provenance: { ...provenance, sourceUrl: finalUrl },
        }
      } catch (error) {
        if (error instanceof RobotsDisallowedError) {
          // A domain exists and robots.txt answered - that is a website, we are
          // just not allowed in. Reporting has_website: false here would be wrong.
          return {
            values: {
              "web.presence.has_website": true,
              "web.presence.reachable": false,
              "web.presence.robots_blocked": true,
            },
            provenance: { ...provenance, sourceUrl: url },
          }
        }

        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.debug({ domain, error: message }, "web.presence unreachable")

        // A domain is recorded, it just does not answer - a parked domain or a
        // dead site. Distinguishable from "no domain at all" by has_website.
        return {
          values: {
            "web.presence.has_website": true,
            "web.presence.reachable": false,
          },
          provenance: { ...provenance, sourceUrl: url },
          error: message,
        }
      }
    },
  }
}
