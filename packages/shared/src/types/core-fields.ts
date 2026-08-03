import { type Operator } from "./search.js"
import { type SignalDef } from "./signals.js"
import { type TargetType } from "./target.js"

/**
 * The `core.*` filter fields.
 *
 * These are the properties every entity has before any provider runs: name,
 * address, coordinates, category. Discovery adapters serve them directly, which
 * is why the planner treats a `core.*` reference as already satisfied and starts
 * no provider for it.
 *
 * They are declared here rather than in the signal registry because no provider
 * produces them - but the filter UI still has to offer them, with the same
 * shape it gets for a real signal. Reusing SignalDef keeps the frontend on one
 * code path instead of two.
 */

export interface CoreFieldDef extends SignalDef {
  /** Target types this field is meaningful for. */
  appliesTo: TargetType[]
  /**
   * Adapters that can push this filter down to the source.
   *
   * Empty means every adapter has to fetch first and filter afterwards, which
   * is slower and, for a paid source, more expensive - the UI can warn.
   */
  pushedDownBy: string[]
}

const ALL_TARGETS: TargetType[] = ["local_business", "company", "person", "list"]
const BUSINESS_TARGETS: TargetType[] = ["local_business", "company"]

const STRING_OPS: Operator[] = ["eq", "neq", "in", "nin", "contains", "exists"]

export const CORE_FIELDS: CoreFieldDef[] = [
  {
    key: "core.geo",
    type: "object",
    // `within` takes either a bbox or a centre plus radius; both are objects.
    operators: ["within"],
    labelKey: "filter.core.geo",
    appliesTo: ALL_TARGETS,
    pushedDownBy: ["overpass", "google_places"],
  },
  {
    key: "core.category",
    type: "string_array",
    operators: ["eq", "in", "nin", "exists"],
    labelKey: "filter.core.category",
    appliesTo: BUSINESS_TARGETS,
    pushedDownBy: ["overpass", "google_places"],
  },
  {
    key: "core.name",
    type: "string",
    operators: STRING_OPS,
    labelKey: "filter.core.name",
    appliesTo: ALL_TARGETS,
    pushedDownBy: ["overpass", "google_places"],
  },
  {
    key: "core.city",
    type: "string",
    operators: STRING_OPS,
    labelKey: "filter.core.city",
    appliesTo: ALL_TARGETS,
    pushedDownBy: ["overpass", "google_places"],
  },
  {
    key: "core.postal_code",
    type: "string",
    operators: STRING_OPS,
    labelKey: "filter.core.postal_code",
    appliesTo: ALL_TARGETS,
    pushedDownBy: ["overpass"],
  },
  {
    key: "core.country",
    type: "string",
    operators: ["eq", "neq", "in", "nin", "exists"],
    labelKey: "filter.core.country",
    unit: "ISO 3166-1 alpha-2",
    appliesTo: ALL_TARGETS,
    pushedDownBy: ["overpass"],
  },
  {
    key: "core.domain",
    type: "string",
    operators: STRING_OPS,
    labelKey: "filter.core.domain",
    appliesTo: ALL_TARGETS,
    // Normalized on our side after fetching, so no source can pre-filter on it.
    pushedDownBy: [],
  },
  {
    key: "core.phone",
    type: "string",
    operators: STRING_OPS,
    labelKey: "filter.core.phone",
    unit: "E.164",
    appliesTo: ALL_TARGETS,
    pushedDownBy: [],
  },
  {
    key: "core.email",
    type: "string",
    operators: STRING_OPS,
    labelKey: "filter.core.email",
    appliesTo: ALL_TARGETS,
    pushedDownBy: [],
  },
]

/** The core fields that make sense for one target type. */
export function coreFieldsFor(targetType?: TargetType): CoreFieldDef[] {
  if (!targetType) return CORE_FIELDS
  return CORE_FIELDS.filter((field) => field.appliesTo.includes(targetType))
}

export const CORE_FIELD_KEYS: string[] = CORE_FIELDS.map((field) => field.key)

/** True for a key discovery supplies, so the planner starts no provider for it. */
export function isCoreField(key: string): boolean {
  return key.startsWith("core.")
}
