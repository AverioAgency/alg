import {
  collectFilterKeys,
  type Rubric,
  type SearchSpec,
  type SignalProvider,
  type TargetType,
} from "@alg/shared"
import { type ResolvedPlan, type SignalRegistry } from "./registry.js"

/**
 * Decides what a run actually has to compute.
 *
 * Three things can reference a signal: a filter in the search, a criterion in the
 * rubric, or a variable in a message template. The planner collects those
 * references, resolves them to providers, and runs nothing else.
 *
 * This is the property the whole system rests on. A market-research search with
 * every rubric weight at zero must not trigger a single website crawl, and a
 * search that never mentions web.* must not start the scraper at all. Anything
 * that quietly runs "just in case" turns a free search into an expensive one.
 */

/** Signals that come from discovery itself and need no provider. */
const CORE_PREFIX = "core."

export interface PlanInput {
  spec: SearchSpec
  /** Optional: without a rubric, only filters and templates are considered. */
  rubric?: Rubric | null
  /**
   * Variables referenced by the campaign's templates, e.g.
   * ["web.presence.has_website", "legal.impressum.email"].
   */
  templateVariables?: readonly string[]
  targetType?: TargetType
}

export interface SignalPlan extends ResolvedPlan {
  /** Where each referenced key came from, for the cost preview. */
  references: {
    fromFilters: string[]
    fromRubric: string[]
    fromTemplates: string[]
  }
  /** core.* keys, which discovery already supplies. */
  coreKeys: string[]
  /** True when no provider needs to run at all. */
  empty: boolean
}

/**
 * Collects every signal reference and resolves the provider DAG.
 *
 * A criterion with weight 0 still counts as a reference: the user asked to see
 * that column even if it does not affect the ranking. Dropping it would silently
 * blank a field they explicitly configured.
 */
export function planSignals(input: PlanInput, registry: SignalRegistry): SignalPlan {
  const targetType = input.targetType ?? input.spec.targetType

  const fromFilters = collectFilterKeys(input.spec.filters)
  const fromRubric = [
    ...(input.rubric?.criteria ?? []).map((criterion) => criterion.signal),
    // LLM criteria reference signals in their prompt text; those are resolved by
    // the scoring layer, not here, because the prompt is free text.
  ]
  const fromTemplates = [...(input.templateVariables ?? [])]

  const all = [...fromFilters, ...fromRubric, ...fromTemplates]
  const coreKeys = [...new Set(all.filter((key) => key.startsWith(CORE_PREFIX)))]
  const signalKeys = [...new Set(all.filter((key) => !key.startsWith(CORE_PREFIX)))]

  const resolved = registry.resolve(signalKeys, targetType)

  return {
    ...resolved,
    references: {
      fromFilters: [...new Set(fromFilters)],
      fromRubric: [...new Set(fromRubric)],
      fromTemplates: [...new Set(fromTemplates)],
    },
    coreKeys,
    empty: resolved.order.length === 0,
  }
}

export interface CostPreview {
  entities: number
  costPerEntityEur: number
  totalEur: number
  perProvider: { providerId: string; costPerEntityEur: number; totalEur: number }[]
  /** Providers pulled in by a dependency rather than asked for directly. */
  transitive: string[]
  /** Referenced keys no provider can supply. */
  unresolved: string[]
}

/**
 * What a run would cost before anything executes.
 *
 * Deliberately shown per provider: "12 EUR" is not actionable, "10 EUR of that is
 * web.techstack" tells the user which criterion to drop.
 */
export function estimateSignalCost(plan: SignalPlan, entities: number): CostPreview {
  const perProvider = plan.order.map((provider) => ({
    providerId: provider.id,
    costPerEntityEur: provider.cost.amount,
    totalEur: Number((provider.cost.amount * entities).toFixed(4)),
  }))

  return {
    entities,
    costPerEntityEur: plan.estimatedCostPerEntity,
    totalEur: Number((plan.estimatedCostPerEntity * entities).toFixed(4)),
    perProvider,
    transitive: plan.transitive,
    unresolved: plan.unresolved,
  }
}

/**
 * Groups the plan into stages that can run concurrently.
 *
 * Providers in the same stage have no dependency on each other, so they can be
 * executed in parallel; the next stage waits for the previous one.
 */
export function toStages(plan: SignalPlan): SignalProvider[][] {
  const stages: SignalProvider[][] = []
  const placed = new Map<string, number>()

  for (const provider of plan.order) {
    const dependencyStages = provider.dependsOn
      .map((id) => placed.get(id))
      .filter((stage): stage is number => stage !== undefined)

    const stage = dependencyStages.length > 0 ? Math.max(...dependencyStages) + 1 : 0
    placed.set(provider.id, stage)

    if (!stages[stage]) stages[stage] = []
    stages[stage].push(provider)
  }

  return stages
}
