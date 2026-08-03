import { type Rubric } from "@alg/shared"

/**
 * The three example rubrics from the specification.
 *
 * They exist to prove the engine has no built-in notion of a good lead: the same
 * code produces three different rankings from the same companies, purely because
 * the data differs. Every signal referenced here is one M2 actually produces.
 */

/**
 * Selling website work: the ideal lead has no site, or an outdated one.
 *
 * Inverted from what most scoring systems do - a perfect website scores zero
 * here, because there is nothing left to sell.
 */
export const WEBSITE_SALES_RUBRIC: Rubric = {
  criteria: [
    {
      label: "Keine Website vorhanden",
      signal: "web.presence.has_website",
      condition: { op: "eq", value: false },
      weight: 50,
      hard: false,
    },
    {
      label: "Website nicht erreichbar",
      signal: "web.presence.reachable",
      condition: { op: "eq", value: false },
      weight: 35,
      hard: false,
    },
    {
      label: "Nicht mobiloptimiert",
      signal: "web.features.mobile_ready",
      condition: { op: "eq", value: false },
      weight: 30,
      hard: false,
    },
    {
      label: "Kein HTTPS",
      signal: "web.presence.https",
      condition: { op: "eq", value: false },
      weight: 25,
      hard: false,
    },
    {
      label: "Baukasten statt eigener Website",
      signal: "web.techstack.builder",
      condition: { op: "exists", value: true },
      weight: 20,
      hard: false,
    },
    {
      label: "Kein Kontaktformular",
      signal: "web.features.contact_form",
      condition: { op: "eq", value: false },
      weight: 15,
      hard: false,
    },
    {
      label: "Keine strukturierten Daten",
      signal: "web.features.structured_data",
      condition: { op: "eq", value: false },
      weight: 10,
      hard: false,
    },
    {
      // Without a way to reach them, the best-fitting lead is worthless.
      label: "Erreichbar per Mail oder Telefon",
      signal: "contact.basic.reachable",
      condition: { op: "eq", value: true },
      weight: 20,
      hard: true,
    },
  ],
  threshold: 40,
}

/**
 * ERP replacement candidates.
 *
 * Uses website modernity as a proxy for digital maturity: a company still
 * running TYPO3 from 2015 rarely has a current ERP either. Genuinely better
 * signals - job postings mentioning SAP, hiring for IT roles - need the hiring
 * provider, which M2 does not have. Stated plainly rather than faked.
 */
export const ERP_REPLACEMENT_RUBRIC: Rubric = {
  criteria: [
    {
      label: "Veraltetes CMS im Einsatz",
      signal: "web.techstack.cms",
      condition: { op: "in", value: ["TYPO3", "Joomla", "Contao", "Drupal"] },
      weight: 30,
      hard: false,
    },
    {
      label: "Nicht mobiloptimiert",
      signal: "web.features.mobile_ready",
      condition: { op: "eq", value: false },
      weight: 20,
      hard: false,
    },
    {
      label: "Kein Tracking eingerichtet",
      signal: "web.techstack.has_tracking",
      condition: { op: "eq", value: false },
      weight: 15,
      hard: false,
    },
    {
      label: "Keine strukturierten Daten",
      signal: "web.features.structured_data",
      condition: { op: "eq", value: false },
      weight: 10,
      hard: false,
    },
    {
      // A running shop system means the digital stack was touched recently,
      // which makes an ERP replacement less likely.
      label: "Betreibt bereits ein Shop-System",
      signal: "web.techstack.shop",
      condition: { op: "exists", value: true },
      weight: -25,
      hard: false,
    },
    {
      label: "Firmenbuchnummer im Impressum",
      signal: "legal.impressum.company_register_number",
      condition: { op: "exists", value: true },
      weight: 15,
      hard: false,
    },
    {
      label: "Geschäftsführung namentlich bekannt",
      signal: "legal.impressum.managing_directors",
      condition: { op: "exists", value: true },
      weight: 20,
      hard: false,
    },
    {
      label: "Website erreichbar",
      signal: "web.presence.reachable",
      condition: { op: "eq", value: true },
      weight: 10,
      hard: true,
    },
  ],
  llmCriteria: [
    {
      prompt:
        "Beurteile anhand der Signale, wie wahrscheinlich dieses Unternehmen ein veraltetes oder gar kein ERP-System einsetzt. Achte auf Betriebsgröße, Digitalisierungsgrad der Website und Branche.",
      weight: 25,
    },
  ],
  threshold: 45,
}

/**
 * Market research: every weight at zero.
 *
 * The case the specification calls out explicitly. Nothing ranks, nothing is
 * excluded, and - because the planner treats a zero-weight criterion as a
 * reference - the referenced signals are still collected. The user wanted those
 * columns, they just do not want a ranking.
 */
export const MARKET_RESEARCH_RUBRIC: Rubric = {
  criteria: [
    {
      label: "Hat Website",
      signal: "web.presence.has_website",
      condition: { op: "eq", value: true },
      weight: 0,
      hard: false,
    },
    {
      label: "CMS",
      signal: "web.techstack.cms",
      condition: { op: "exists", value: true },
      weight: 0,
      hard: false,
    },
    {
      label: "Shop-System",
      signal: "web.techstack.shop",
      condition: { op: "exists", value: true },
      weight: 0,
      hard: false,
    },
    {
      label: "Impressum gefunden",
      signal: "legal.impressum.found",
      condition: { op: "eq", value: true },
      weight: 0,
      hard: false,
    },
    {
      label: "Kontakt vorhanden",
      signal: "contact.basic.reachable",
      condition: { op: "eq", value: true },
      weight: 0,
      hard: false,
    },
  ],
  threshold: 0,
}

export interface RubricTemplate {
  slug: string
  nameKey: string
  descriptionKey: string
  rubric: Rubric
}

/** Seeded into every new workspace as a starting point. */
export const RUBRIC_TEMPLATES: RubricTemplate[] = [
  {
    slug: "website-sales",
    nameKey: "rubric.website_sales.name",
    descriptionKey: "rubric.website_sales.description",
    rubric: WEBSITE_SALES_RUBRIC,
  },
  {
    slug: "erp-replacement",
    nameKey: "rubric.erp_replacement.name",
    descriptionKey: "rubric.erp_replacement.description",
    rubric: ERP_REPLACEMENT_RUBRIC,
  },
  {
    slug: "market-research",
    nameKey: "rubric.market_research.name",
    descriptionKey: "rubric.market_research.description",
    rubric: MARKET_RESEARCH_RUBRIC,
  },
]
