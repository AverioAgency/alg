/**
 * Google Places pricing, versioned and dated.
 *
 * Prices belong in a dated config file, never inline in the code: when Google
 * changes them, the estimate a user saw before starting a run has to remain
 * reconstructible. Add a new entry, do not edit an old one.
 */

export interface PricingTable {
  /** ISO date this schedule took effect. */
  effectiveFrom: string
  currency: "EUR"
  /** Cost per request, not per returned place. */
  perRequest: {
    textSearch: number
    nearbySearch: number
    placeDetails: number
  }
  /** Places returns at most this many results per page. */
  pageSize: number
  /** Text/Nearby Search paginate at most this often. */
  maxPages: number
}

/**
 * USD list prices converted at 0.92 EUR/USD. Google bills in USD per 1000
 * requests: Text Search 32, Nearby 32, Place Details 17.
 */
export const PLACES_PRICING_2026_01: PricingTable = {
  effectiveFrom: "2026-01-01",
  currency: "EUR",
  perRequest: {
    textSearch: 0.02944,
    nearbySearch: 0.02944,
    placeDetails: 0.01564,
  },
  pageSize: 20,
  maxPages: 3,
}

export const CURRENT_PLACES_PRICING = PLACES_PRICING_2026_01

/**
 * Cost of a search that fetches `limit` places and, optionally, details for each.
 *
 * Details are a separate billed request per place, which dominates the bill -
 * hence they are opt-in and the estimate says so plainly.
 */
export function estimatePlacesCost(input: {
  limit: number
  withDetails: boolean
  pricing?: PricingTable
}): { requests: number; costEur: number; pages: number } {
  const pricing = input.pricing ?? CURRENT_PLACES_PRICING

  const pages = Math.min(pricing.maxPages, Math.max(1, Math.ceil(input.limit / pricing.pageSize)))
  const reachable = Math.min(input.limit, pages * pricing.pageSize)

  const searchCost = pages * pricing.perRequest.textSearch
  const detailsCost = input.withDetails ? reachable * pricing.perRequest.placeDetails : 0

  return {
    requests: pages + (input.withDetails ? reachable : 0),
    costEur: Number((searchCost + detailsCost).toFixed(4)),
    pages,
  }
}
