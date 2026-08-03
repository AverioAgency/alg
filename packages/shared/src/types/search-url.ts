import { fromBase64Url, toBase64Url } from "./pagination.js"
import {
  MATCH_ALL,
  SearchSpecSchema,
  isBranchNode,
  isLeafNode,
  isNotNode,
  type FilterNode,
  type SearchSpec,
} from "./search.js"

/**
 * Turns a SearchSpec into query parameters and back.
 *
 * A search has to survive being copied out of the address bar, pasted into a
 * chat and opened by a colleague. Two encodings serve that:
 *
 * - Readable, for the common shape - a target type, a place, a category, a
 *   limit. Those become plain parameters a human can read and edit by hand.
 * - Opaque, for everything else. An arbitrary AND/OR/NOT tree has no honest flat
 *   representation, so it is base64url-encoded JSON in a single `q` parameter.
 *
 * The round trip is the contract: decode(encode(spec)) must equal spec. A
 * readable encoding that silently loses a filter would be worse than no readable
 * encoding at all, so encodeSearchSpec only uses it when it provably round-trips.
 */

/** Leaf keys the readable form can express, and the parameter each maps to. */
const READABLE_KEYS: Record<string, string> = {
  "core.category": "category",
  "core.city": "city",
  "core.postal_code": "postcode",
  "core.country": "country",
  "core.name": "name",
}

const READABLE_PARAMS: Record<string, string> = Object.fromEntries(
  Object.entries(READABLE_KEYS).map(([key, param]) => [param, key])
)

export interface EncodeOptions {
  /**
   * Forces the opaque form.
   *
   * Useful when the caller wants one stable parameter regardless of the filter
   * shape - a saved-search record, for instance, where a spec gaining an OR
   * branch should not change how it is stored.
   */
  opaque?: boolean
}

/**
 * Encodes a spec as URLSearchParams.
 *
 * Prefers the readable form and falls back to the opaque one whenever the tree
 * cannot be expressed flatly - a nested OR, a negation, an operator other than
 * equality or membership, or a filter key with no readable equivalent.
 */
export function encodeSearchSpec(spec: SearchSpec, options: EncodeOptions = {}): URLSearchParams {
  const params = new URLSearchParams()

  if (!options.opaque) {
    const readable = toReadableParams(spec)
    if (readable) return readable
  }

  params.set("target_type", spec.targetType)
  params.set("q", toBase64Url(new TextEncoder().encode(JSON.stringify(spec.filters))))
  if (spec.limit !== undefined) params.set("limit", String(spec.limit))
  if (spec.sources?.length) params.set("sources", spec.sources.join(","))

  return params
}

/** Convenience wrapper: the query string on its own, without a leading "?". */
export function encodeSearchSpecToQuery(spec: SearchSpec, options: EncodeOptions = {}): string {
  return encodeSearchSpec(spec, options).toString()
}

export interface DecodeResult {
  spec: SearchSpec | null
  /** Why decoding failed, as a stable slug rather than a sentence. */
  errorKey?: "invalid_q" | "invalid_spec" | "missing_target_type"
}

/**
 * Decodes query parameters back into a spec.
 *
 * Returns a result rather than throwing: these values come from a URL a user
 * pasted, so a malformed one is expected input, not an exception. The caller
 * decides whether that is a 400 or an empty form.
 */
export function decodeSearchSpec(input: URLSearchParams | string): DecodeResult {
  const params = typeof input === "string" ? new URLSearchParams(input) : input

  const targetType = params.get("target_type")
  if (!targetType) return { spec: null, errorKey: "missing_target_type" }

  const opaque = params.get("q")
  let filters: FilterNode

  if (opaque) {
    const parsed = decodeOpaqueFilters(opaque)
    if (!parsed) return { spec: null, errorKey: "invalid_q" }
    filters = parsed
  } else {
    filters = fromReadableParams(params)
  }

  const candidate: Record<string, unknown> = { targetType, filters }

  const limit = params.get("limit")
  if (limit !== null) {
    const value = Number(limit)
    // A non-numeric limit is dropped rather than defaulted: guessing 100 when
    // the user wrote "abc" would run a search they did not ask for.
    if (Number.isInteger(value) && value > 0) candidate.limit = value
  }

  const sources = params.get("sources")
  if (sources) {
    const list = sources
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
    if (list.length > 0) candidate.sources = list
  }

  const result = SearchSpecSchema.safeParse(candidate)
  return result.success ? { spec: result.data } : { spec: null, errorKey: "invalid_spec" }
}

/**
 * Renders the readable form, or null when the tree cannot be expressed flatly.
 *
 * Null is the important case: returning a partial encoding would produce a URL
 * that looks right and runs a different search.
 */
function toReadableParams(spec: SearchSpec): URLSearchParams | null {
  const leaves = flattenTopLevelAnd(spec.filters)
  if (leaves === null) return null

  const params = new URLSearchParams()
  params.set("target_type", spec.targetType)

  for (const leaf of leaves) {
    // Geo is readable but shaped: bbox or centre plus radius, never a bare value.
    if (leaf.key === "core.geo") {
      const geo = toReadableGeo(leaf.value, leaf.op)
      if (!geo) return null
      for (const [name, value] of geo) params.set(name, value)
      continue
    }

    const param = READABLE_KEYS[leaf.key]
    if (!param) return null

    if (leaf.op === "eq" && typeof leaf.value === "string") {
      params.set(param, leaf.value)
    } else if (leaf.op === "in" && Array.isArray(leaf.value)) {
      if (!leaf.value.every((entry) => typeof entry === "string")) return null
      // Comma-joined, so a value containing a comma would decode as two values.
      if (leaf.value.some((entry) => entry.includes(","))) return null
      params.set(param, leaf.value.join(","))
    } else {
      return null
    }
  }

  if (spec.limit !== undefined) params.set("limit", String(spec.limit))
  if (spec.sources?.length) params.set("sources", spec.sources.join(","))

  return params
}

/**
 * Returns the leaves of a flat top-level AND, or null for any other shape.
 *
 * MATCH_ALL (an empty AND) yields an empty list, which is a legal readable
 * encoding meaning "no filters".
 */
function flattenTopLevelAnd(
  node: FilterNode
): { key: string; op: string; value: unknown }[] | null {
  // A bare leaf is rejected even though it looks trivially encodable. The
  // readable parameters carry no bracketing, so decoding always rebuilds an AND
  // branch - a bare leaf would come back wrapped and the round trip would not
  // hold. The opaque form preserves the shape exactly.
  if (isLeafNode(node)) return null

  if (isNotNode(node)) return null

  if (isBranchNode(node)) {
    if (node.op !== "and") return null

    const leaves: { key: string; op: string; value: unknown }[] = []
    for (const child of node.children) {
      // Only one level: a nested AND is expressible in principle, but flattening
      // it would not round-trip back to the same tree.
      if (!isLeafNode(child)) return null
      leaves.push({ key: child.key, op: child.op, value: child.value })
    }
    return leaves
  }

  return null
}

function toReadableGeo(value: unknown, op: string): [string, string][] | null {
  if (op !== "within" || typeof value !== "object" || value === null) return null
  const spec = Object.fromEntries(Object.entries(value))

  if (Array.isArray(spec.bbox) && spec.bbox.length === 4) {
    const bbox = spec.bbox.map(Number)
    if (!bbox.every((entry) => Number.isFinite(entry))) return null
    return [["bbox", bbox.join(",")]]
  }

  const lat = Number(spec.lat)
  const lon = Number(spec.lon)
  const radius = Number(spec.radiusMetres)
  if ([lat, lon, radius].every((entry) => Number.isFinite(entry)) && radius > 0) {
    // Only these three keys: an object carrying anything else would lose it.
    if (Object.keys(spec).length !== 3) return null
    return [
      ["lat", String(lat)],
      ["lon", String(lon)],
      ["radius", String(radius)],
    ]
  }

  return null
}

function fromReadableParams(params: URLSearchParams): FilterNode {
  const children: FilterNode[] = []

  const bbox = params.get("bbox")
  if (bbox) {
    const parts = bbox.split(",").map(Number)
    if (parts.length === 4 && parts.every((entry) => Number.isFinite(entry))) {
      children.push({ op: "within", key: "core.geo", value: { bbox: parts } })
    }
  } else {
    const lat = Number(params.get("lat"))
    const lon = Number(params.get("lon"))
    const radius = Number(params.get("radius"))
    if ([lat, lon, radius].every((entry) => Number.isFinite(entry)) && radius > 0) {
      children.push({
        op: "within",
        key: "core.geo",
        value: { lat, lon, radiusMetres: radius },
      })
    }
  }

  for (const [param, key] of Object.entries(READABLE_PARAMS)) {
    const raw = params.get(param)
    if (raw === null || raw === "") continue

    const values = raw.split(",").filter((entry) => entry.length > 0)
    if (values.length === 0) continue

    children.push(
      values.length === 1 ? { op: "eq", key, value: values[0] } : { op: "in", key, value: values }
    )
  }

  return children.length === 0 ? MATCH_ALL : { op: "and", children }
}

function decodeOpaqueFilters(value: string): FilterNode | null {
  try {
    const json = new TextDecoder().decode(fromBase64Url(value))
    const parsed: unknown = JSON.parse(json)
    // Validated by SearchSpecSchema in the caller; here we only need it to be a
    // plausible node so a malformed payload fails as invalid_q rather than
    // surfacing as a confusing schema error.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
    if (!("op" in parsed)) return null
    // eslint-disable-next-line no-restricted-syntax
    return parsed as FilterNode
  } catch {
    return null
  }
}
