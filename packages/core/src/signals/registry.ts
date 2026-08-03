import {
  type SignalDef,
  type SignalProvider,
  type SignalProviderDescriptor,
  type TargetType,
} from "@alg/shared"

/**
 * Holds the signal providers and resolves what actually has to run.
 *
 * The central property of this system: a provider runs only when something
 * references one of the signals it produces - a filter, a rubric criterion or a
 * template variable. Nothing else triggers it. That is not an optimization; it is
 * what keeps a market-research search from paying for website crawls it never
 * looks at.
 */

export class UnknownProviderError extends Error {
  constructor(id: string) {
    super(`No signal provider registered with id "${id}"`)
    this.name = "UnknownProviderError"
  }
}

export class CircularDependencyError extends Error {
  readonly cycle: string[]

  constructor(cycle: string[]) {
    super(`Circular provider dependency: ${cycle.join(" -> ")}`)
    this.name = "CircularDependencyError"
    this.cycle = cycle
  }
}

export class DuplicateSignalError extends Error {
  constructor(key: string, providers: string[]) {
    super(`Signal "${key}" is produced by more than one provider: ${providers.join(", ")}`)
    this.name = "DuplicateSignalError"
  }
}

export interface ResolvedPlan {
  /** Providers in execution order; dependencies come before their dependents. */
  order: SignalProvider[]
  /** Signal keys that were asked for but no provider produces. */
  unresolved: string[]
  /** Providers pulled in only because something else depends on them. */
  transitive: string[]
  estimatedCostPerEntity: number
}

export class SignalRegistry {
  private readonly providers = new Map<string, SignalProvider>()
  /** signal key -> provider id, for demand-driven lookup. */
  private readonly signalIndex = new Map<string, string>()

  register(provider: SignalProvider): this {
    if (this.providers.has(provider.id)) {
      throw new Error(`Signal provider "${provider.id}" is already registered`)
    }

    for (const def of provider.provides) {
      const existing = this.signalIndex.get(def.key)
      if (existing) {
        // Two providers claiming the same key makes the plan ambiguous, and the
        // resulting data would depend on registration order.
        throw new DuplicateSignalError(def.key, [existing, provider.id])
      }
    }

    this.providers.set(provider.id, provider)
    for (const def of provider.provides) {
      this.signalIndex.set(def.key, provider.id)
    }
    return this
  }

  get(id: string): SignalProvider {
    const provider = this.providers.get(id)
    if (!provider) throw new UnknownProviderError(id)
    return provider
  }

  has(id: string): boolean {
    return this.providers.has(id)
  }

  all(): SignalProvider[] {
    return [...this.providers.values()]
  }

  /** The provider that produces a given signal key, if any. */
  providerFor(signalKey: string): SignalProvider | null {
    const id = this.signalIndex.get(signalKey)
    return id ? (this.providers.get(id) ?? null) : null
  }

  /** Every signal definition, for GET /v1/filters/schema. */
  signalDefs(targetType?: TargetType): SignalDef[] {
    return this.all()
      .filter((p) => !targetType || p.appliesTo.includes(targetType))
      .flatMap((p) => p.provides)
  }

  /** Serializable view of the registry, for the frontend. */
  describe(targetType?: TargetType): SignalProviderDescriptor[] {
    return this.all()
      .filter((p) => !targetType || p.appliesTo.includes(targetType))
      .map((p) => ({
        id: p.id,
        version: p.version,
        provides: p.provides,
        dependsOn: p.dependsOn,
        appliesTo: p.appliesTo,
        cost: p.cost,
        ttlDays: p.ttlDays,
      }))
  }

  /**
   * Works out which providers have to run for a set of referenced signal keys.
   *
   * Pulls in dependencies transitively and returns them topologically sorted, so
   * a provider never runs before the signals it reads have been produced.
   */
  resolve(referencedKeys: readonly string[], targetType?: TargetType): ResolvedPlan {
    const unresolved: string[] = []
    const required = new Set<string>()
    const directlyRequested = new Set<string>()

    for (const key of new Set(referencedKeys)) {
      const provider = this.providerFor(key)
      if (!provider) {
        unresolved.push(key)
        continue
      }
      if (targetType && !provider.appliesTo.includes(targetType)) {
        // Applying to a different target type is not an error - a person search
        // simply cannot use a company-only provider.
        unresolved.push(key)
        continue
      }
      required.add(provider.id)
      directlyRequested.add(provider.id)
    }

    // Pull in dependencies transitively.
    const queue = [...required]
    while (queue.length > 0) {
      const id = queue.pop()
      if (!id) continue
      const provider = this.providers.get(id)
      if (!provider) continue

      for (const dependency of provider.dependsOn) {
        if (!this.providers.has(dependency)) {
          unresolved.push(`${id} depends on unknown provider ${dependency}`)
          continue
        }
        if (!required.has(dependency)) {
          required.add(dependency)
          queue.push(dependency)
        }
      }
    }

    const order = this.topologicalSort([...required])

    return {
      order,
      unresolved,
      transitive: order.map((p) => p.id).filter((id) => !directlyRequested.has(id)),
      estimatedCostPerEntity: Number(order.reduce((sum, p) => sum + p.cost.amount, 0).toFixed(4)),
    }
  }

  /**
   * Depth-first topological sort with cycle detection.
   *
   * A cycle is a configuration error, not something to work around: running
   * either provider first would give the other incomplete input, and which one
   * wins would depend on map iteration order.
   */
  private topologicalSort(ids: readonly string[]): SignalProvider[] {
    const sorted: SignalProvider[] = []
    const visited = new Set<string>()
    const inProgress = new Set<string>()
    const path: string[] = []

    const visit = (id: string): void => {
      if (visited.has(id)) return
      if (inProgress.has(id)) {
        throw new CircularDependencyError([...path.slice(path.indexOf(id)), id])
      }

      const provider = this.providers.get(id)
      if (!provider) return

      inProgress.add(id)
      path.push(id)

      for (const dependency of provider.dependsOn) {
        if (this.providers.has(dependency)) visit(dependency)
      }

      path.pop()
      inProgress.delete(id)
      visited.add(id)
      sorted.push(provider)
    }

    // Sort the entry points for a deterministic plan: the same spec must produce
    // the same order on every run, or cost estimates would wobble.
    for (const id of [...ids].sort()) visit(id)

    return sorted
  }
}
