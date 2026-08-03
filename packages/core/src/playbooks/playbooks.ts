import {
  ERP_REPLACEMENT_RUBRIC,
  MARKET_RESEARCH_RUBRIC,
  WEBSITE_SALES_RUBRIC,
} from "../scoring/fixtures.js"
import { type Rubric, type SearchSpec, type TargetType } from "@alg/shared"

/**
 * A playbook is a preconfigured starting point: a search plus a rubric, ready to
 * run and meant to be edited.
 *
 * The three here are the same three cases the rubric fixtures cover, which is
 * the point - one engine, three completely different notions of a good lead, no
 * code branching on any of them. A user who wants a fourth writes it as data.
 *
 * The outreach sequence a full playbook would also carry arrives with M5. Until
 * then `sequence` is null rather than a placeholder, so nothing pretends to
 * offer messaging that does not exist yet.
 */

export interface Playbook {
  slug: string
  /** i18n keys; the German strings live in the frontend. */
  nameKey: string
  descriptionKey: string
  targetType: TargetType
  /** The search to start from. The region is a default the user will change. */
  spec: SearchSpec
  rubric: Rubric
  /** Arrives with M5. Null, not an empty object - there is nothing to run yet. */
  sequence: null
  /**
   * What this playbook costs per company before it produces a score.
   *
   * Derived from the signals its rubric references, so it is visible in the
   * onboarding list rather than after the first run. Zero means rule-only
   * scoring on data discovery already supplied.
   */
  referencedSignals: string[]
}

/** Upper Austria: where the first users are. A default, not a constraint. */
const OBEROESTERREICH: [number, number, number, number] = [47.42, 12.75, 48.78, 15.0]

function referencedSignals(rubric: Rubric): string[] {
  return [...new Set(rubric.criteria.map((criterion) => criterion.signal))]
}

export const PLAYBOOKS: Playbook[] = [
  {
    slug: "website-sales",
    nameKey: "playbook.website_sales.name",
    descriptionKey: "playbook.website_sales.description",
    targetType: "local_business",
    spec: {
      targetType: "local_business",
      filters: {
        op: "and",
        children: [
          { op: "within", key: "core.geo", value: { bbox: OBEROESTERREICH } },
          {
            op: "in",
            key: "core.category",
            value: ["restaurant", "hairdresser", "bakery", "butcher", "florist"],
          },
        ],
      },
      limit: 500,
    },
    rubric: WEBSITE_SALES_RUBRIC,
    sequence: null,
    referencedSignals: referencedSignals(WEBSITE_SALES_RUBRIC),
  },
  {
    slug: "erp-replacement",
    nameKey: "playbook.erp_replacement.name",
    descriptionKey: "playbook.erp_replacement.description",
    targetType: "company",
    spec: {
      targetType: "company",
      filters: {
        op: "and",
        children: [
          { op: "within", key: "core.geo", value: { bbox: OBEROESTERREICH } },
          { op: "in", key: "core.category", value: ["company", "industrial", "craft_business"] },
        ],
      },
      limit: 500,
    },
    rubric: ERP_REPLACEMENT_RUBRIC,
    sequence: null,
    referencedSignals: referencedSignals(ERP_REPLACEMENT_RUBRIC),
  },
  {
    slug: "market-research",
    nameKey: "playbook.market_research.name",
    descriptionKey: "playbook.market_research.description",
    targetType: "company",
    spec: {
      targetType: "company",
      filters: {
        op: "and",
        children: [{ op: "within", key: "core.geo", value: { bbox: OBEROESTERREICH } }],
      },
      limit: 1000,
    },
    // Every weight at zero: the signals are collected and reported, nothing is
    // ranked and nothing is excluded. A market survey, not a lead list.
    rubric: MARKET_RESEARCH_RUBRIC,
    sequence: null,
    referencedSignals: referencedSignals(MARKET_RESEARCH_RUBRIC),
  },
]

export function playbookBySlug(slug: string): Playbook | null {
  return PLAYBOOKS.find((playbook) => playbook.slug === slug) ?? null
}
