import { type FilterNode, isBranchNode, isLeafNode, isNotNode } from "@alg/shared"

/**
 * Translates the subset of a FilterNode tree that Overpass can serve into
 * Overpass QL.
 *
 * Overpass has no general boolean algebra: a query is a union of element
 * selectors, each an AND of tag conditions. So only the AND-of-leaves shape is
 * pushed down; anything else the caller evaluates afterwards. Claiming more
 * support than that would silently drop results.
 */

/** Filter keys this adapter serves natively. Mirrors OverpassAdapter.supports. */
export const OVERPASS_SUPPORTED_KEYS = [
  "core.geo",
  "core.category",
  "core.name",
  "core.city",
  "core.postal_code",
  "core.country",
] as const

export interface OverpassArea {
  /** [south, west, north, east] */
  bbox?: [number, number, number, number]
  around?: { lat: number; lon: number; radiusMetres: number }
}

export interface OverpassQueryPlan {
  area: OverpassArea
  /** OSM tag filters, already escaped. */
  tagFilters: string[]
  limit: number
  /** Keys that could not be pushed down and must be applied afterwards. */
  unsupported: string[]
}

/**
 * Maps our neutral category vocabulary onto OSM tags. Deliberately small and
 * data-driven: a category the map does not know is not an error, it just means
 * Overpass is the wrong source for that search.
 */
const CATEGORY_TAGS: Record<string, string[]> = {
  restaurant: ["amenity=restaurant"],
  cafe: ["amenity=cafe"],
  bar: ["amenity=bar"],
  hotel: ["tourism=hotel"],
  bakery: ["shop=bakery"],
  butcher: ["shop=butcher"],
  hairdresser: ["shop=hairdresser"],
  supermarket: ["shop=supermarket"],
  pharmacy: ["amenity=pharmacy"],
  doctor: ["amenity=doctors"],
  dentist: ["amenity=dentist"],
  car_repair: ["shop=car_repair"],
  car_dealer: ["shop=car"],
  florist: ["shop=florist"],
  optician: ["shop=optician"],
  furniture: ["shop=furniture"],
  hardware: ["shop=hardware", "shop=doityourself"],
  clothes: ["shop=clothes"],
  electronics: ["shop=electronics"],
  craft: ["office=craft", "shop=trade"],
  gym: ["leisure=fitness_centre"],
  veterinary: ["amenity=veterinary"],
}

export function knownCategories(): string[] {
  return Object.keys(CATEGORY_TAGS)
}

/** Escapes a value for use inside an Overpass QL double-quoted string. */
export function escapeOverpassValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

/**
 * Walks the filter tree and extracts what Overpass can do. Only leaves under a
 * top-level AND are considered; OR and NOT fall through to post-filtering.
 */
export function planOverpassQuery(filters: FilterNode, limit: number): OverpassQueryPlan {
  const plan: OverpassQueryPlan = {
    area: {},
    tagFilters: [],
    limit,
    unsupported: [],
  }

  const leaves: { key: string; op: string; value: unknown }[] = []

  const collect = (node: FilterNode, negated: boolean): void => {
    if (isNotNode(node)) {
      // Overpass cannot express negation of a whole subtree.
      collect(node.child, true)
      return
    }
    if (isBranchNode(node)) {
      if (node.op === "and" && !negated) {
        node.children.forEach((child) => collect(child, false))
      } else {
        // An OR branch (or anything under NOT) is evaluated on our side.
        node.children.forEach((child) => {
          for (const key of collectKeys(child)) plan.unsupported.push(key)
        })
      }
      return
    }
    if (isLeafNode(node)) {
      if (negated) {
        plan.unsupported.push(node.key)
      } else {
        leaves.push({ key: node.key, op: node.op, value: node.value })
      }
    }
  }

  collect(filters, false)

  for (const leaf of leaves) {
    switch (leaf.key) {
      case "core.geo": {
        const area = toArea(leaf.value)
        if (area) {
          plan.area = area
        } else {
          plan.unsupported.push(leaf.key)
        }
        break
      }
      case "core.category": {
        const tags = toCategoryTags(leaf.value)
        if (tags.length > 0) {
          plan.tagFilters.push(...tags)
        } else {
          plan.unsupported.push(leaf.key)
        }
        break
      }
      case "core.name":
        if (typeof leaf.value === "string" && leaf.value.length > 0) {
          const escaped = escapeOverpassValue(leaf.value)
          // ~ is a regex match, "i" makes it case-insensitive.
          plan.tagFilters.push(
            leaf.op === "contains" ? `["name"~"${escaped}",i]` : `["name"="${escaped}"]`
          )
        } else {
          plan.unsupported.push(leaf.key)
        }
        break
      case "core.city":
        pushTag(plan, "addr:city", leaf.value, leaf.key)
        break
      case "core.postal_code":
        pushTag(plan, "addr:postcode", leaf.value, leaf.key)
        break
      case "core.country":
        pushTag(plan, "addr:country", leaf.value, leaf.key)
        break
      default:
        plan.unsupported.push(leaf.key)
    }
  }

  return plan
}

function pushTag(plan: OverpassQueryPlan, tag: string, value: unknown, key: string): void {
  if (typeof value === "string" && value.length > 0) {
    plan.tagFilters.push(`["${tag}"="${escapeOverpassValue(value)}"]`)
  } else {
    plan.unsupported.push(key)
  }
}

function collectKeys(node: FilterNode): string[] {
  if (isBranchNode(node)) return node.children.flatMap(collectKeys)
  if (isNotNode(node)) return collectKeys(node.child)
  return isLeafNode(node) ? [node.key] : []
}

function toArea(value: unknown): OverpassArea | null {
  if (typeof value !== "object" || value === null) return null
  const spec = value as {
    bbox?: unknown
    lat?: unknown
    lon?: unknown
    radiusMetres?: unknown
  }

  if (Array.isArray(spec.bbox) && spec.bbox.length === 4) {
    const bbox = spec.bbox.map(Number)
    if (bbox.every((n) => Number.isFinite(n))) {
      return { bbox: bbox as [number, number, number, number] }
    }
    return null
  }

  const lat = Number(spec.lat)
  const lon = Number(spec.lon)
  const radiusMetres = Number(spec.radiusMetres)
  if ([lat, lon, radiusMetres].every((n) => Number.isFinite(n)) && radiusMetres > 0) {
    return { around: { lat, lon, radiusMetres } }
  }

  return null
}

function toCategoryTags(value: unknown): string[] {
  const categories = Array.isArray(value) ? value : [value]
  const tags: string[] = []

  for (const category of categories) {
    if (typeof category !== "string") continue
    const mapped = CATEGORY_TAGS[category.toLowerCase()]
    if (mapped) {
      tags.push(...mapped.map((tag) => tagToFilter(tag)))
    }
  }

  return tags
}

function tagToFilter(tag: string): string {
  const [key = "", value = ""] = tag.split("=")
  return `["${escapeOverpassValue(key)}"="${escapeOverpassValue(value)}"]`
}

/**
 * Renders the plan as Overpass QL.
 *
 * Queries node, way and relation because businesses are mapped as all three: a
 * shop can be a point, a building outline or a multipolygon. `out center` gives
 * ways and relations a representative coordinate.
 */
export function renderOverpassQl(plan: OverpassQueryPlan, timeoutSeconds = 60): string {
  const areaClause = plan.area.bbox
    ? `(${plan.area.bbox.join(",")})`
    : plan.area.around
      ? `(around:${plan.area.around.radiusMetres},${plan.area.around.lat},${plan.area.around.lon})`
      : ""

  // Multiple category tags mean a union, not an intersection: a search for
  // "hardware" must match shop=hardware OR shop=doityourself.
  const categoryFilters = plan.tagFilters.filter((f) =>
    /^\["(amenity|shop|tourism|office|leisure)"/.test(f)
  )
  const otherFilters = plan.tagFilters.filter((f) => !categoryFilters.includes(f))
  const selectors = categoryFilters.length > 0 ? categoryFilters : [""]

  const parts: string[] = []
  for (const selector of selectors) {
    const combined = `${selector}${otherFilters.join("")}`
    for (const element of ["node", "way", "relation"]) {
      parts.push(`  ${element}${combined}${areaClause};`)
    }
  }

  return [
    `[out:json][timeout:${timeoutSeconds}];`,
    "(",
    ...parts,
    ");",
    `out center ${plan.limit};`,
  ].join("\n")
}
