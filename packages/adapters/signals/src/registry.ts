import { Crawler, SignalRegistry } from "@alg/core"
import { createContactBasicProvider } from "./contact-basic/provider.js"
import { createLegalImpressumProvider } from "./legal-impressum/provider.js"
import { createWebPresenceProvider } from "./web-presence/provider.js"
import { createWebTechstackProvider } from "./web-techstack/provider.js"

export interface SignalRegistryOptions {
  userAgent: string
  /** Shared across providers so the per-host rate limit actually holds. */
  crawler?: Crawler
  minDelayMs?: number
}

/**
 * Assembles the signal registry.
 *
 * One crawler instance for every provider on purpose: the rate limit is per host,
 * and three providers each with their own crawler would happily hit the same site
 * three times at once.
 *
 * web.quality is absent - it needs Playwright, which is deferred.
 */
export function buildSignalRegistry(options: SignalRegistryOptions): SignalRegistry {
  const crawler =
    options.crawler ??
    new Crawler({
      userAgent: options.userAgent,
      ...(options.minDelayMs !== undefined ? { minDelayMs: options.minDelayMs } : {}),
    })

  return new SignalRegistry()
    .register(createWebPresenceProvider({ crawler }))
    .register(createLegalImpressumProvider({ crawler }))
    .register(createWebTechstackProvider({ crawler }))
    .register(createContactBasicProvider())
}
