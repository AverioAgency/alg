import { DiscoveryRegistry } from "@alg/core"
import { OverpassAdapter, PlacesAdapter } from "@alg/adapters-discovery"
import { type Env } from "@alg/shared"

/**
 * Assembles the discovery registry from what is configured.
 *
 * An adapter without credentials is left out rather than registered and failing
 * at run time: the planner should never select a source it cannot reach, and the
 * cost preview would otherwise promise results that never arrive.
 *
 * The CSV adapter is absent by design - it takes its content from the request
 * rather than from configuration, so it is constructed per import.
 */
export function buildRegistry(env: Env): DiscoveryRegistry {
  const registry = new DiscoveryRegistry()

  // Free and keyless, so always available.
  registry.register(
    new OverpassAdapter({
      endpoint: env.OVERPASS_ENDPOINT,
      userAgent: env.ALG_USER_AGENT,
    })
  )

  if (env.GOOGLE_PLACES_API_KEY) {
    registry.register(
      new PlacesAdapter({
        apiKey: env.GOOGLE_PLACES_API_KEY,
        userAgent: env.ALG_USER_AGENT,
      })
    )
  }

  return registry
}
