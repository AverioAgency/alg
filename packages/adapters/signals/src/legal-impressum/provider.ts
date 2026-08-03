import {
  type Entity,
  type RunContext,
  type SignalBundle,
  type SignalDef,
  type SignalProvider,
  type TargetType,
} from "@alg/shared"
import { type Crawler, normalizeDomain, normalizeEmail, normalizePhone } from "@alg/core"
import { IMPRESSUM_PATHS, extractImpressum, findImpressumLinks } from "./extract.js"

/**
 * Reads the Impressum, which Austrian and German sites are legally required to
 * publish (ECG §5, DDG §5).
 *
 * The most reliable contact source available: a real address, a real phone
 * number, and the managing director's name, all stated by the company itself.
 * Guessing info@domain is the alternative, and it is a much worse one.
 *
 * Depends on web.presence so it only runs where there is a reachable site.
 */

const PROVIDES: SignalDef[] = [
  {
    key: "legal.impressum.found",
    type: "boolean",
    operators: ["eq", "neq", "exists"],
    labelKey: "signal.legal.impressum.found",
  },
  {
    key: "legal.impressum.email",
    type: "string",
    operators: ["eq", "contains", "exists"],
    labelKey: "signal.legal.impressum.email",
  },
  {
    key: "legal.impressum.phone",
    type: "string",
    operators: ["eq", "contains", "exists"],
    labelKey: "signal.legal.impressum.phone",
  },
  {
    key: "legal.impressum.company_register_number",
    type: "string",
    operators: ["eq", "contains", "exists"],
    labelKey: "signal.legal.impressum.company_register_number",
  },
  {
    key: "legal.impressum.vat_id",
    type: "string",
    operators: ["eq", "contains", "exists"],
    labelKey: "signal.legal.impressum.vat_id",
  },
  {
    key: "legal.impressum.managing_directors",
    type: "string_array",
    operators: ["contains", "intersects", "exists"],
    labelKey: "signal.legal.impressum.managing_directors",
  },
  {
    key: "legal.impressum.url",
    type: "string",
    operators: ["eq", "contains", "exists"],
    labelKey: "signal.legal.impressum.url",
  },
]

export interface LegalImpressumOptions {
  crawler: Crawler
  /** How many candidate paths to try before giving up. */
  maxAttempts?: number
}

export function createLegalImpressumProvider(options: LegalImpressumOptions): SignalProvider {
  const maxAttempts = options.maxAttempts ?? 4

  return {
    id: "legal.impressum",
    version: "1.0.0",
    provides: PROVIDES,
    dependsOn: ["web.presence"],
    appliesTo: ["local_business", "company"] satisfies TargetType[],
    cost: { unit: "per_entity", amount: 0, currency: "EUR" },
    // Impressum data changes rarely; a quarter is a reasonable window and keeps
    // the crawl volume down.
    ttlDays: 90,

    async run(entity: Entity, ctx: RunContext): Promise<SignalBundle> {
      const provenance = {
        providerId: "legal.impressum",
        providerVersion: "1.0.0",
        fetchedAt: new Date().toISOString(),
      }

      // web.presence ran first; skip the crawl entirely when there is no site.
      const hasWebsite = entity.signals?.["web.presence.has_website"]
      const reachable = entity.signals?.["web.presence.reachable"]
      const domain = entity.domain ?? normalizeDomain(entity.website ?? null)

      if (hasWebsite === false || reachable === false || !domain) {
        return { values: { "legal.impressum.found": false }, provenance }
      }

      const base = `https://${domain}`
      const candidates = IMPRESSUM_PATHS.map((path) => `${base}${path}`)
      let discoveredFromHomepage = false

      for (let i = 0; i < candidates.length && i < maxAttempts; i++) {
        if (ctx.signal.aborted) break
        const url = candidates[i]
        if (!url) continue

        try {
          const response = await options.crawler.fetch(url, { signal: ctx.signal })
          if (response.status !== 200) continue

          const data = extractImpressum(response.body, domain)

          // A 200 from a soft-404 page is common; require it to look like an
          // Impressum before trusting what was extracted.
          if (!data.looksLikeImpressum && !data.email) continue

          return {
            values: {
              "legal.impressum.found": true,
              "legal.impressum.email": normalizeEmail(data.email),
              "legal.impressum.phone": normalizePhone(data.phone, countryOf(entity)),
              "legal.impressum.company_register_number": data.companyRegisterNumber,
              "legal.impressum.vat_id": data.vatId,
              "legal.impressum.managing_directors": data.managingDirectors,
              "legal.impressum.url": response.url,
            },
            provenance: { ...provenance, sourceUrl: response.url },
          }
        } catch (error) {
          ctx.logger.debug({ url, error: String(error) }, "impressum candidate failed")
        }

        // None of the usual paths worked - read the homepage and follow whatever
        // it links to. Done once, and only after the cheap guesses are exhausted.
        if (i === candidates.length - 1 || i === maxAttempts - 1) {
          if (discoveredFromHomepage) break
          discoveredFromHomepage = true

          try {
            const home = await options.crawler.fetch(`${base}/`, { signal: ctx.signal })
            const links = findImpressumLinks(home.body, base)
            candidates.push(...links.filter((link) => !candidates.includes(link)))
          } catch {
            break
          }
        }
      }

      return { values: { "legal.impressum.found": false }, provenance }
    },
  }
}

/** The country decides how a national phone number is read. */
function countryOf(entity: Entity): "AT" | "DE" | "CH" {
  const country = entity.address?.country?.toUpperCase()
  return country === "DE" || country === "CH" ? country : "AT"
}
