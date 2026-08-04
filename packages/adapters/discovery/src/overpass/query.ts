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
  /**
   * The subset of tagFilters that came from core.category.
   *
   * Tracked rather than re-derived from the tag name at render time: categories
   * are a union (hardware means shop=hardware OR shop=doityourself) while every
   * other filter is an intersection. Guessing from the key would break the
   * moment a category maps onto a tag the guess does not know - which is exactly
   * what adding the company vocabulary does.
   */
  categoryFilters: string[]
  limit: number
  /** Keys that could not be pushed down and must be applied afterwards. */
  unsupported: string[]
}

/**
 * Maps our neutral category vocabulary onto OSM tags. Deliberately small and
 * data-driven: a category the map does not know is not an error, it just means
 * Overpass is the wrong source for that search.
 *
 * Two groups. The first serves local_business - the shops and venues a passer-by
 * would recognize. The second, further down, serves company: firms, workshops
 * and industrial sites. OSM maps those far less completely than restaurants, so
 * a company search returns a starting set to enrich, not a register - which is
 * why COMPANY_CATEGORIES is kept separate and documented as such.
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

/**
 * Company-side vocabulary: firms rather than storefronts.
 *
 * OSM's coverage here is thinner and more uneven than for shops - a joinery with
 * a shopfront is usually mapped, the same joinery in an industrial park often is
 * not. Treat a company search as a seed list for enrichment, not a register.
 * Verified against the live API for the Linz/Wels area: office=* returns 635
 * objects, craft=* returns 246.
 *
 * `craft` deserves its own note: the OSM value is the trade itself
 * (craft=carpenter, craft=electrician), so the bare key matches every trade at
 * once. That is what "Handwerksbetriebe" means in practice, and enumerating the
 * ~70 documented values here would go stale the moment the wiki adds one.
 */
const COMPANY_CATEGORY_TAGS: Record<string, string[]> = {
  /** Every mapped office, whatever its kind. The broadest company selector. */
  company: ["office=company", "office=commercial"],
  office: ["office"],
  /** Every craft trade at once - carpenter, electrician, plumber, and so on. */
  craft_business: ["craft"],
  /** Production sites. man_made=works is the factory itself. */
  industrial: ["man_made=works", "building=industrial"],
  /** The industrial estate as an area. Coarse: one polygon can cover many firms. */
  industrial_area: ["landuse=industrial"],
  commercial_area: ["landuse=commercial"],
  /** Wholesale and trade businesses. */
  wholesale: ["shop=wholesale", "shop=trade"],
  /** Common office subtypes, for narrower searches. */
  it_company: ["office=it"],
  lawyer: ["office=lawyer"],
  accountant: ["office=accountant"],
  insurance: ["office=insurance"],
  estate_agent: ["office=estate_agent"],
  architect: ["office=architect"],
  engineer: ["office=engineer"],
  advertising: ["office=advertising_agency"],
  logistics: ["office=logistics", "industrial=depot"],
  research: ["office=research"],
  employment_agency: ["office=employment_agency"],
  financial: ["office=financial"],
}

/** Every category name, whichever target type it belongs to. */
export function knownCategories(): string[] {
  return [...Object.keys(CATEGORY_TAGS), ...Object.keys(COMPANY_CATEGORY_TAGS)]
}

/** What a company search can ask for. Drives the filter schema in the UI. */
export function knownCompanyCategories(): string[] {
  return Object.keys(COMPANY_CATEGORY_TAGS)
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
    categoryFilters: [],
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
          plan.categoryFilters.push(...tags)
        } else {
          // An unknown category is not an error: it means Overpass is the wrong
          // source for this search, and the caller filters afterwards.
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
        /**
         * Der Ort geht NICHT an Overpass, sondern in den Nachfilter.
         *
         * `addr:city` ist in OSM oft nicht gesetzt und nicht indiziert. Gemessen
         * fuer "Elektro" in Oberoesterreich: mit `["addr:city"="Linz"]` kamen
         * nach 61s vier Treffer, ohne den Tag nach 3s fuenfzehn - dieselben
         * Betriebe, nur ohne die, denen jemand das Tag nie eingetragen hat.
         *
         * Der Nachfilter entscheidet besser: er hat die Koordinate, und
         * `core.geo` schneidet ohnehin exakt zu. Ein fehlendes Tag ist dort
         * "unbelegt", an der Quelle waere es "verworfen".
         */
        plan.unsupported.push(leaf.key)
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
    const key = category.toLowerCase()
    const mapped = CATEGORY_TAGS[key] ?? COMPANY_CATEGORY_TAGS[key]
    if (mapped) {
      tags.push(...mapped.map((tag) => tagToFilter(tag)))
    }
  }

  return tags
}

/**
 * Renders one OSM tag as an Overpass selector.
 *
 * A bare key without "=" means "this key with any value", which is how the broad
 * company selectors work: craft=* matches every trade, office=* every kind of
 * office. Enumerating the ~70 documented craft values instead would go stale.
 */
function tagToFilter(tag: string): string {
  if (!tag.includes("=")) {
    return `["${escapeOverpassValue(tag)}"]`
  }
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
  // "hardware" must match shop=hardware OR shop=doityourself. Which filters are
  // categories is recorded by the planner rather than guessed from the tag name.
  const categoryFilters = plan.categoryFilters
  const otherFilters = plan.tagFilters.filter((f) => !categoryFilters.includes(f))

  /**
   * With no category chosen, search the business tags rather than everything.
   *
   * An empty selector renders as `node(bbox); way(bbox); relation(bbox);`, which
   * asks Overpass for *every object in the area* - every tree, every lamp post,
   * every building outline. Over a province that is millions of elements: the
   * query dies on the server's time limit, the adapter retries it across three
   * endpoints, and the user waits minutes for nothing.
   *
   * `["name"]` is barely better and was measured as the worst option of all -
   * 105s against a mirror for Upper Austria, because every named street and
   * hamlet matches. These five tags are what actually carries a business, and
   * the same query returns in seconds.
   */
  const ALL_BUSINESS_SELECTORS = [
    '["shop"]',
    '["amenity"]',
    '["craft"]',
    '["office"]',
    '["tourism"]',
  ]
  const selectors = categoryFilters.length > 0 ? categoryFilters : ALL_BUSINESS_SELECTORS

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
