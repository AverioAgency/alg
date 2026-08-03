import { type TargetType } from "./target.js"

/**
 * The neutral category vocabulary.
 *
 * Source-independent on purpose: Overpass maps these onto OSM tags, Google
 * Places turns them into a text query, and a future source will do something
 * else again. The user picks "Tischlerei", not "craft=carpenter".
 *
 * It lives in @alg/shared because the filter UI needs it and because a category
 * name is part of a saved SearchSpec - renaming one silently changes what an
 * existing search means.
 */

export interface CategoryDef {
  /** Stable identifier. Appears in SearchSpec, so never rename one in place. */
  slug: string
  /** i18n key for the user-visible name; the German string lives in the frontend. */
  labelKey: string
  targetType: TargetType
}

/** Shops and venues: what OSM maps thoroughly. */
const LOCAL_BUSINESS_SLUGS = [
  "restaurant",
  "cafe",
  "bar",
  "hotel",
  "bakery",
  "butcher",
  "hairdresser",
  "supermarket",
  "pharmacy",
  "doctor",
  "dentist",
  "car_repair",
  "car_dealer",
  "florist",
  "optician",
  "furniture",
  "hardware",
  "clothes",
  "electronics",
  "craft",
  "gym",
  "veterinary",
] as const

/**
 * Firms rather than storefronts.
 *
 * OSM's coverage here is thinner and uneven - a joinery with a shopfront is
 * usually mapped, the same joinery in an industrial park often is not. Verified
 * against the live API for the Linz/Wels area: office=* returns 635 objects,
 * craft=* 246, man_made=works 462. Worth searching, but a company search is a
 * seed list to enrich rather than a register.
 */
const COMPANY_SLUGS = [
  "company",
  "office",
  "craft_business",
  "industrial",
  "industrial_area",
  "commercial_area",
  "wholesale",
  "it_company",
  "lawyer",
  "accountant",
  "insurance",
  "estate_agent",
  "architect",
  "engineer",
  "advertising",
  "logistics",
  "research",
  "employment_agency",
  "financial",
] as const

function define(slugs: readonly string[], targetType: TargetType): CategoryDef[] {
  return slugs.map((slug) => ({ slug, labelKey: `category.${slug}`, targetType }))
}

export const CATEGORIES: CategoryDef[] = [
  ...define(LOCAL_BUSINESS_SLUGS, "local_business"),
  ...define(COMPANY_SLUGS, "company"),
]

export function categoriesFor(targetType?: TargetType): CategoryDef[] {
  if (!targetType) return CATEGORIES
  return CATEGORIES.filter((category) => category.targetType === targetType)
}

export const CATEGORY_SLUGS: string[] = CATEGORIES.map((category) => category.slug)
