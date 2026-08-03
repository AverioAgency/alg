import {
  type Entity,
  type RunContext,
  type SignalBundle,
  type SignalDef,
  type SignalProvider,
  type TargetType,
} from "@alg/shared"
import { type Crawler, normalizeDomain } from "@alg/core"
import { detectFeatures, detectTech } from "./detect.js"

/**
 * What the website is built with, and what it can do.
 *
 * Reads the homepage once and derives both the technology fingerprint and the
 * feature flags from it - a second request for the same page would be wasted.
 *
 * Which of these matters is entirely the user's decision: "runs WordPress" is a
 * buying signal for one user and a disqualifier for the next. The provider only
 * reports.
 */

const PROVIDES: SignalDef[] = [
  {
    key: "web.techstack.cms",
    type: "string",
    operators: ["eq", "neq", "in", "nin", "contains", "exists"],
    labelKey: "signal.web.techstack.cms",
  },
  {
    key: "web.techstack.shop",
    type: "string",
    operators: ["eq", "neq", "in", "nin", "exists"],
    labelKey: "signal.web.techstack.shop",
  },
  {
    key: "web.techstack.builder",
    type: "string",
    operators: ["eq", "neq", "in", "nin", "exists"],
    labelKey: "signal.web.techstack.builder",
  },
  {
    key: "web.techstack.analytics",
    type: "string_array",
    operators: ["contains", "intersects", "exists"],
    labelKey: "signal.web.techstack.analytics",
  },
  {
    key: "web.techstack.has_tracking",
    type: "boolean",
    operators: ["eq", "neq", "exists"],
    labelKey: "signal.web.techstack.has_tracking",
  },
  {
    key: "web.features.contact_form",
    type: "boolean",
    operators: ["eq", "neq", "exists"],
    labelKey: "signal.web.features.contact_form",
  },
  {
    key: "web.features.cookie_banner",
    type: "boolean",
    operators: ["eq", "neq", "exists"],
    labelKey: "signal.web.features.cookie_banner",
  },
  {
    key: "web.features.mobile_ready",
    type: "boolean",
    operators: ["eq", "neq", "exists"],
    labelKey: "signal.web.features.mobile_ready",
  },
  {
    key: "web.features.structured_data",
    type: "boolean",
    operators: ["eq", "neq", "exists"],
    labelKey: "signal.web.features.structured_data",
  },
  {
    key: "web.features.social_links",
    type: "string_array",
    operators: ["contains", "intersects", "exists"],
    labelKey: "signal.web.features.social_links",
  },
]

export interface WebTechstackOptions {
  crawler: Crawler
}

export function createWebTechstackProvider(options: WebTechstackOptions): SignalProvider {
  return {
    id: "web.techstack",
    version: "1.0.0",
    provides: PROVIDES,
    dependsOn: ["web.presence"],
    appliesTo: ["local_business", "company"] satisfies TargetType[],
    cost: { unit: "per_entity", amount: 0, currency: "EUR" },
    ttlDays: 60,

    async run(entity: Entity, ctx: RunContext): Promise<SignalBundle> {
      const provenance = {
        providerId: "web.techstack",
        providerVersion: "1.0.0",
        fetchedAt: new Date().toISOString(),
      }

      const reachable = entity.signals?.["web.presence.reachable"]
      const domain = entity.domain ?? normalizeDomain(entity.website ?? null)

      if (reachable === false || !domain) {
        // Nothing to fingerprint. Returning no values rather than false ones
        // keeps "not measured" distinguishable from "measured as absent".
        return { values: {}, provenance }
      }

      // web.presence already resolved redirects; reuse its final URL so a
      // redirect chain is not walked twice.
      const finalUrl =
        typeof entity.signals?.["web.presence.final_url"] === "string"
          ? String(entity.signals["web.presence.final_url"])
          : `https://${domain}/`

      try {
        const response = await options.crawler.fetch(finalUrl, { signal: ctx.signal })

        if (response.status !== 200) {
          return { values: {}, provenance, error: `status ${response.status}` }
        }

        const tech = detectTech(response.body, response.headers)
        const features = detectFeatures(response.body, response.url)

        return {
          values: {
            "web.techstack.cms": tech.cms,
            "web.techstack.shop": tech.shop,
            "web.techstack.builder": tech.builder,
            "web.techstack.analytics": tech.analytics,
            "web.techstack.has_tracking": tech.hasTracking,
            "web.features.contact_form": features.hasContactForm,
            "web.features.cookie_banner": features.hasCookieBanner,
            "web.features.mobile_ready": features.hasViewportMeta,
            "web.features.structured_data": features.hasStructuredData,
            "web.features.social_links": features.hasSocialLinks,
          },
          provenance: { ...provenance, sourceUrl: response.url },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.debug({ domain, error: message }, "web.techstack failed")
        return { values: {}, provenance, error: message }
      }
    },
  }
}
