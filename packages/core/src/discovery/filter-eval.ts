import { type FilterNode, type Operator, isBranchNode, isLeafNode, isNotNode } from "@alg/shared"

/**
 * Evaluates a FilterNode tree against a flat record of values.
 *
 * Used for the filters a discovery adapter could not push down, and later by the
 * scoring layer for rubric conditions. Semantics that matter:
 *
 *   - An absent key is not the same as a false value. `exists` is the only
 *     operator that treats absence as meaningful; every other operator returns
 *     false for a missing key rather than pretending it knows.
 *   - An empty AND matches everything (MATCH_ALL), an empty OR matches nothing.
 */

export interface EvalOptions {
  /** Distance in metres for `within` when the value carries no radius. */
  defaultRadiusMetres?: number
}

export function evaluateFilter(
  node: FilterNode,
  values: Record<string, unknown>,
  options: EvalOptions = {}
): boolean {
  if (isBranchNode(node)) {
    return node.op === "and"
      ? node.children.every((child) => evaluateFilter(child, values, options))
      : node.children.some((child) => evaluateFilter(child, values, options))
  }

  if (isNotNode(node)) {
    return !evaluateFilter(node.child, values, options)
  }

  if (!isLeafNode(node)) return false

  const present = Object.prototype.hasOwnProperty.call(values, node.key)
  const actual = values[node.key]

  if (node.op === "exists") {
    const wanted = node.value === undefined ? true : Boolean(node.value)
    const has = present && actual !== null && actual !== undefined
    return has === wanted
  }

  // Everything else needs a value to compare against.
  if (!present || actual === null || actual === undefined) return false

  return compare(node.op, actual, node.value, options)
}

function compare(op: Operator, actual: unknown, expected: unknown, options: EvalOptions): boolean {
  switch (op) {
    case "eq":
      return looseEquals(actual, expected)
    case "neq":
      return !looseEquals(actual, expected)
    case "lt":
    case "lte":
    case "gt":
    case "gte":
      return compareOrdered(op, actual, expected)
    case "in":
      return toArray(expected).some((candidate) => looseEquals(actual, candidate))
    case "nin":
      return !toArray(expected).some((candidate) => looseEquals(actual, candidate))
    case "contains":
      return contains(actual, expected)
    case "intersects": {
      const left = toArray(actual)
      const right = toArray(expected)
      return left.some((l) => right.some((r) => looseEquals(l, r)))
    }
    case "within":
      return within(actual, expected, options)
    case "exists":
      // Handled by the caller, which knows whether the key was present at all.
      return false
    default:
      return false
  }
}

function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  // Sources are inconsistent about numeric strings ("20" vs 20); compare by value.
  if (typeof a === "number" && typeof b === "string") return a === Number(b)
  if (typeof a === "string" && typeof b === "number") return Number(a) === b
  if (typeof a === "string" && typeof b === "string") {
    return a.toLowerCase() === b.toLowerCase()
  }
  return false
}

function compareOrdered(
  op: "lt" | "lte" | "gt" | "gte",
  actual: unknown,
  expected: unknown
): boolean {
  const a = toComparable(actual)
  const b = toComparable(expected)
  if (a === null || b === null) return false

  switch (op) {
    case "lt":
      return a < b
    case "lte":
      return a <= b
    case "gt":
      return a > b
    case "gte":
      return a >= b
  }
}

/** Numbers and ISO dates are both orderable; anything else is not. */
function toComparable(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (value instanceof Date) return value.getTime()
  if (typeof value === "string") {
    const asNumber = Number(value)
    if (value.trim() !== "" && Number.isFinite(asNumber)) return asNumber
    const asDate = Date.parse(value)
    if (Number.isFinite(asDate)) return asDate
  }
  return null
}

function contains(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual)) {
    return actual.some((item) => looseEquals(item, expected))
  }
  if (
    typeof actual === "string" &&
    (typeof expected === "string" || typeof expected === "number")
  ) {
    return actual.toLowerCase().includes(String(expected).toLowerCase())
  }
  return false
}

function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (value === null || value === undefined) return []
  return [value]
}

/**
 * Geo containment. Accepts `{ lat, lon }` on the entity side and either
 * `{ lat, lon, radiusMetres }` or `{ bbox: [south, west, north, east] }` as the
 * filter value.
 */
function within(actual: unknown, expected: unknown, options: EvalOptions): boolean {
  const point = toPoint(actual)
  if (!point) return false
  if (typeof expected !== "object" || expected === null) return false

  const spec = expected as {
    lat?: unknown
    lon?: unknown
    radiusMetres?: unknown
    bbox?: unknown
  }

  if (Array.isArray(spec.bbox) && spec.bbox.length === 4) {
    const [south, west, north, east] = spec.bbox.map(Number)
    if ([south, west, north, east].some((n) => !Number.isFinite(n))) return false
    return (
      point.lat >= (south as number) &&
      point.lat <= (north as number) &&
      point.lon >= (west as number) &&
      point.lon <= (east as number)
    )
  }

  const centre = toPoint(spec)
  if (!centre) return false
  const radius = Number(spec.radiusMetres ?? options.defaultRadiusMetres ?? 0)
  if (!Number.isFinite(radius) || radius <= 0) return false

  return haversineMetres(point, centre) <= radius
}

function toPoint(value: unknown): { lat: number; lon: number } | null {
  if (typeof value !== "object" || value === null) return null
  const candidate = value as { lat?: unknown; lon?: unknown }
  const lat = Number(candidate.lat)
  const lon = Number(candidate.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null
  return { lat, lon }
}

const EARTH_RADIUS_M = 6_371_000

export function haversineMetres(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number }
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)

  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h))
}
