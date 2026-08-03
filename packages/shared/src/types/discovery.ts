import { z } from "zod"
import { type SearchSpec } from "./search.js"
import { type TargetType } from "./target.js"
import { type RawEntity } from "./entities.js"

export const CostEstimateSchema = z.object({
  /** Expected number of entities returned. */
  estimatedEntities: z.number().int().nonnegative(),
  /** Monetary cost in EUR. Free sources report 0. */
  estimatedCostEur: z.number().nonnegative(),
  /** Rough wall-clock estimate, for the preview UI. */
  estimatedSeconds: z.number().nonnegative().optional(),
  /** True when the adapter cannot serve the spec natively and would over-fetch. */
  degraded: z.boolean().default(false),
  notes: z.array(z.string()).optional(),
})

export type CostEstimate = z.infer<typeof CostEstimateSchema>

export const DiscoveryResultSchema = z.object({
  entities: z.array(z.unknown()),
  cursor: z.string().optional(),
})

export interface DiscoveryResult {
  entities: RawEntity[]
  cursor?: string
}

/**
 * A source of entities. Adapters declare which filter keys they can push down
 * (`supports`); everything else the planner evaluates after the fact.
 */
export interface DiscoveryAdapter {
  id: string
  targetTypes: TargetType[]
  /** Filter keys this adapter can serve natively (pushed into the source query). */
  supports: string[]
  estimateCost(spec: SearchSpec): CostEstimate
  search(spec: SearchSpec, cursor?: string): Promise<DiscoveryResult>
}
