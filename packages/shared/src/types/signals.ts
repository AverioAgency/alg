import { z } from "zod"
import { OperatorSchema, type Operator } from "./search.js"
import { TargetTypeSchema, type TargetType } from "./target.js"
import { type Entity } from "./entities.js"

export const SignalValueTypeSchema = z.enum([
  "boolean",
  "number",
  "string",
  "string_array",
  "date",
  "object",
])

export type SignalValueType = z.infer<typeof SignalValueTypeSchema>

/**
 * The declaration of one field a provider produces. The filter registry
 * (GET /v1/filters/schema) is generated from these - which is why labels live
 * here as i18n keys rather than as hardcoded German strings.
 */
export const SignalDefSchema = z.object({
  /** Dotted path, must be prefixed with the provider id: "web.presence.has_website". */
  key: z.string().min(1),
  type: SignalValueTypeSchema,
  /** Operators that make sense for this field in filters and rubric conditions. */
  operators: z.array(OperatorSchema).min(1),
  /** i18n key for the user-visible label, e.g. "signal.web.presence.has_website". */
  labelKey: z.string().min(1),
  /** Allowed values for enum-like string fields, for the filter UI. */
  enumValues: z.array(z.string()).optional(),
  unit: z.string().optional(),
})

export type SignalDef = z.infer<typeof SignalDefSchema>

export const SignalCostSchema = z.object({
  unit: z.literal("per_entity"),
  amount: z.number().nonnegative(),
  currency: z.literal("EUR"),
})

export type SignalCost = z.infer<typeof SignalCostSchema>

/** Where a signal value came from, so every filter decision stays auditable. */
export const ProvenanceSchema = z.object({
  providerId: z.string().min(1),
  providerVersion: z.string().min(1),
  fetchedAt: z.iso.datetime(),
  /** URL, API endpoint or file the value was derived from. */
  sourceUrl: z.string().nullable().optional(),
  /** FileStorage id of a screenshot or crawl artifact backing this value. */
  fileId: z.uuid().nullable().optional(),
})

export type Provenance = z.infer<typeof ProvenanceSchema>

export const SignalBundleSchema = z.object({
  /** Flat map of signal key -> value. Keys must be declared in `provides`. */
  values: z.record(z.string(), z.unknown()),
  provenance: ProvenanceSchema,
  /** Set when the provider ran but could not determine values (site down, blocked). */
  error: z.string().nullable().optional(),
})

export type SignalBundle = z.infer<typeof SignalBundleSchema>

/** Context handed to a provider at run time. Never contains raw secrets. */
export interface RunContext {
  workspaceId: string
  runId: string
  /** Aborts when the run is cancelled or the budget is exhausted. */
  signal: AbortSignal
  logger: {
    debug(obj: unknown, msg?: string): void
    info(obj: unknown, msg?: string): void
    warn(obj: unknown, msg?: string): void
    error(obj: unknown, msg?: string): void
  }
}

/**
 * Produces signals for an entity. Providers run only when the planner finds a
 * reference to one of their `provides` keys in a filter, a rubric criterion or a
 * template variable. `dependsOn` forms the DAG edges.
 */
export interface SignalProvider {
  id: string
  /** Bumped when the extraction logic changes; invalidates cached enrichments. */
  version: string
  provides: SignalDef[]
  dependsOn: string[]
  appliesTo: TargetType[]
  cost: SignalCost
  ttlDays: number
  run(entity: Entity, ctx: RunContext): Promise<SignalBundle>
}

/** Serializable view of a provider, for GET /v1/filters/schema. */
export const SignalProviderDescriptorSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  provides: z.array(SignalDefSchema),
  dependsOn: z.array(z.string()),
  appliesTo: z.array(TargetTypeSchema),
  cost: SignalCostSchema,
  ttlDays: z.number().int().positive(),
})

export type SignalProviderDescriptor = z.infer<typeof SignalProviderDescriptorSchema>

export type { Operator, TargetType }
