import {
  type DiscoveryAdapter,
  type SearchSpec,
  type TargetType,
  collectFilterKeys,
} from "@alg/shared"

/**
 * Holds the available discovery adapters and decides which of them may serve a
 * given SearchSpec.
 *
 * Selection is by capability, never by name: an adapter is eligible when it covers
 * the target type, and it is preferred when it can push filters down natively.
 * That is what lets a new source be added without touching the planner.
 */

export interface AdapterSelection {
  adapter: DiscoveryAdapter
  /** Filter keys this adapter serves natively, in the source query. */
  pushedDown: string[]
  /** Filter keys that must be evaluated after the fact, on our side. */
  postFiltered: string[]
}

export class UnknownAdapterError extends Error {
  constructor(id: string) {
    super(`No discovery adapter registered with id "${id}"`)
    this.name = "UnknownAdapterError"
  }
}

export class DiscoveryRegistry {
  private readonly adapters = new Map<string, DiscoveryAdapter>()

  register(adapter: DiscoveryAdapter): this {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Discovery adapter "${adapter.id}" is already registered`)
    }
    this.adapters.set(adapter.id, adapter)
    return this
  }

  get(id: string): DiscoveryAdapter {
    const adapter = this.adapters.get(id)
    if (!adapter) throw new UnknownAdapterError(id)
    return adapter
  }

  has(id: string): boolean {
    return this.adapters.has(id)
  }

  all(): DiscoveryAdapter[] {
    return [...this.adapters.values()]
  }

  /** Adapters that can handle a target type at all. */
  forTargetType(targetType: TargetType): DiscoveryAdapter[] {
    return this.all().filter((adapter) => adapter.targetTypes.includes(targetType))
  }

  /**
   * Chooses the adapters for a spec and splits its filters into pushed-down and
   * post-filtered parts.
   *
   * An explicit `sources` list is honoured as given - if the user names a source
   * that cannot serve the target type, that is an error worth surfacing rather
   * than silently substituting something else.
   */
  select(spec: SearchSpec): AdapterSelection[] {
    const requestedKeys = [...new Set(collectFilterKeys(spec.filters))]

    const candidates =
      spec.sources && spec.sources.length > 0
        ? spec.sources.map((id) => this.get(id))
        : this.forTargetType(spec.targetType)

    return candidates
      .filter((adapter) => adapter.targetTypes.includes(spec.targetType))
      .map((adapter) => {
        const supported = new Set(adapter.supports)
        const pushedDown = requestedKeys.filter((key) => supported.has(key))
        const postFiltered = requestedKeys.filter((key) => !supported.has(key))
        return { adapter, pushedDown, postFiltered }
      })
  }

  /** Sum of the per-adapter estimates, for the preview before anything runs. */
  estimate(spec: SearchSpec): {
    estimatedEntities: number
    estimatedCostEur: number
    perAdapter: { adapterId: string; estimatedEntities: number; estimatedCostEur: number }[]
  } {
    const perAdapter = this.select(spec).map(({ adapter }) => {
      const estimate = adapter.estimateCost(spec)
      return {
        adapterId: adapter.id,
        estimatedEntities: estimate.estimatedEntities,
        estimatedCostEur: estimate.estimatedCostEur,
      }
    })

    return {
      // Upper bound: dedupe will reduce this, by how much we cannot know in advance.
      estimatedEntities: perAdapter.reduce((sum, e) => sum + e.estimatedEntities, 0),
      estimatedCostEur: Number(
        perAdapter.reduce((sum, e) => sum + e.estimatedCostEur, 0).toFixed(4)
      ),
      perAdapter,
    }
  }
}
