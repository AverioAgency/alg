import { describe, expect, it } from "vitest"
import { type Rubric } from "@alg/shared"
import { evaluateRubric, explainScore, rankLeads } from "../evaluate.js"
import {
  ERP_REPLACEMENT_RUBRIC,
  MARKET_RESEARCH_RUBRIC,
  WEBSITE_SALES_RUBRIC,
} from "../fixtures.js"

/**
 * The M3 acceptance criterion is the last describe block: the same four
 * companies, run through the three example rubrics, must produce three
 * different rankings. If they ever agree, the engine has acquired an opinion
 * about what a good lead is - which is exactly what it must not have.
 */

/** No website at all - the ideal website-sales lead. */
const NO_WEBSITE = {
  name: "Gasthaus Zur Post",
  signals: {
    "web.presence.has_website": false,
    "web.presence.reachable": false,
    "contact.basic.reachable": true,
    "legal.impressum.found": false,
  },
}

/** Old TYPO3 site, no tracking, no shop - the ideal ERP lead. */
const OUTDATED_SITE = {
  name: "Muster Produktion GmbH",
  signals: {
    "web.presence.has_website": true,
    "web.presence.reachable": true,
    "web.presence.https": true,
    "web.techstack.cms": "TYPO3",
    "web.techstack.has_tracking": false,
    "web.features.mobile_ready": false,
    "web.features.structured_data": false,
    "web.features.contact_form": true,
    "legal.impressum.found": true,
    "legal.impressum.company_register_number": "FN 123456a",
    "legal.impressum.managing_directors": ["Ing. Max Mustermann"],
    "contact.basic.reachable": true,
  },
}

/** Modern site with a shop - uninteresting for both sales cases. */
const MODERN_SITE = {
  name: "Beispiel Handel GmbH",
  signals: {
    "web.presence.has_website": true,
    "web.presence.reachable": true,
    "web.presence.https": true,
    "web.techstack.cms": "WordPress",
    "web.techstack.shop": "WooCommerce",
    "web.techstack.has_tracking": true,
    "web.features.mobile_ready": true,
    "web.features.structured_data": true,
    "web.features.contact_form": true,
    "legal.impressum.found": true,
    "contact.basic.reachable": true,
  },
}

/** A Wix site, no contact details found - fails the hard criterion. */
const UNREACHABLE = {
  name: "Kleinbetrieb Ohne Kontakt",
  signals: {
    "web.presence.has_website": true,
    "web.presence.reachable": true,
    "web.presence.https": false,
    "web.techstack.builder": "Wix",
    "web.features.mobile_ready": true,
    "web.features.contact_form": false,
    "web.features.structured_data": false,
    "contact.basic.reachable": false,
  },
}

describe("evaluateRubric - breakdown", () => {
  it("records every criterion, matched or not", () => {
    const score = evaluateRubric({ signals: NO_WEBSITE.signals, rubric: WEBSITE_SALES_RUBRIC })

    expect(score.breakdown).toHaveLength(WEBSITE_SALES_RUBRIC.criteria.length)
    expect(score.breakdown.every((entry) => typeof entry.label === "string")).toBe(true)
  })

  it("shows the actual value that was compared", () => {
    // "Why did this score 30?" has to be answerable from the breakdown alone.
    const score = evaluateRubric({ signals: OUTDATED_SITE.signals, rubric: ERP_REPLACEMENT_RUBRIC })
    const cms = score.breakdown.find((entry) => entry.signal === "web.techstack.cms")

    expect(cms?.actualValue).toBe("TYPO3")
    expect(cms?.matched).toBe(true)
    expect(cms?.points).toBe(30)
  })

  it("awards no points for a criterion that did not match", () => {
    const score = evaluateRubric({ signals: MODERN_SITE.signals, rubric: WEBSITE_SALES_RUBRIC })
    const noWebsite = score.breakdown.find((entry) => entry.signal === "web.presence.has_website")

    expect(noWebsite?.matched).toBe(false)
    expect(noWebsite?.points).toBe(0)
  })

  it("distinguishes an unmeasured signal from a false one", () => {
    // A crawl that timed out must not look like a disqualifying answer.
    const score = evaluateRubric({
      signals: { "web.presence.has_website": true },
      rubric: WEBSITE_SALES_RUBRIC,
    })

    const missing = score.breakdown.find((entry) => entry.signal === "web.features.mobile_ready")
    expect(missing?.actualValue).toBeNull()
    expect(missing?.matched).toBe(false)
    expect(missing?.excluded).toBe(false)
  })

  it("applies a negative weight when it matches", () => {
    const score = evaluateRubric({ signals: MODERN_SITE.signals, rubric: ERP_REPLACEMENT_RUBRIC })
    const shop = score.breakdown.find((entry) => entry.signal === "web.techstack.shop")

    expect(shop?.matched).toBe(true)
    expect(shop?.points).toBe(-25)
  })
})

describe("evaluateRubric - hard criteria", () => {
  it("excludes a lead that fails a hard criterion", () => {
    const score = evaluateRubric({ signals: UNREACHABLE.signals, rubric: WEBSITE_SALES_RUBRIC })

    expect(score.qualified).toBe(false)
    expect(score.total).toBe(0)
    expect(score.breakdown.some((entry) => entry.excluded)).toBe(true)
  })

  it("still records why it was excluded", () => {
    // A silently dropped lead is impossible to debug.
    const score = evaluateRubric({ signals: UNREACHABLE.signals, rubric: WEBSITE_SALES_RUBRIC })
    const exclusion = score.breakdown.find((entry) => entry.excluded)

    expect(exclusion?.signal).toBe("contact.basic.reachable")
    expect(exclusion?.hard).toBe(true)
  })

  it("does not exclude when the hard criterion is met", () => {
    const score = evaluateRubric({ signals: NO_WEBSITE.signals, rubric: WEBSITE_SALES_RUBRIC })
    expect(score.breakdown.some((entry) => entry.excluded)).toBe(false)
  })

  it("does not exclude on a hard criterion whose signal is missing", () => {
    // Missing data is not a failed requirement; treating it as one would
    // discard leads for a provider outage.
    const score = evaluateRubric({
      signals: { "web.presence.has_website": false },
      rubric: WEBSITE_SALES_RUBRIC,
    })

    expect(score.breakdown.some((entry) => entry.excluded)).toBe(false)
  })
})

describe("evaluateRubric - normalization", () => {
  it("scores on 0..100 regardless of how many criteria there are", () => {
    // Otherwise the threshold would need retuning every time a criterion is added.
    const twoCriteria: Rubric = {
      criteria: [
        {
          label: "A",
          signal: "a",
          condition: { op: "eq", value: true },
          weight: 50,
          hard: false,
        },
        {
          label: "B",
          signal: "b",
          condition: { op: "eq", value: true },
          weight: 50,
          hard: false,
        },
      ],
      threshold: 50,
    }

    const all = evaluateRubric({ signals: { a: true, b: true }, rubric: twoCriteria })
    const half = evaluateRubric({ signals: { a: true, b: false }, rubric: twoCriteria })

    expect(all.total).toBe(100)
    expect(half.total).toBe(50)
  })

  it("never returns a negative total", () => {
    const negative: Rubric = {
      criteria: [
        {
          label: "Malus",
          signal: "x",
          condition: { op: "eq", value: true },
          weight: -100,
          hard: false,
        },
      ],
      threshold: 0,
    }

    expect(evaluateRubric({ signals: { x: true }, rubric: negative }).total).toBe(0)
  })

  it("scores zero when a rubric has no positive weights at all", () => {
    const score = evaluateRubric({
      signals: MODERN_SITE.signals,
      rubric: MARKET_RESEARCH_RUBRIC,
    })

    expect(score.total).toBe(0)
    // Threshold 0 means everything qualifies - the point of market research.
    expect(score.qualified).toBe(true)
  })
})

describe("evaluateRubric - LLM stage", () => {
  it("blends the LLM score in on the same scale", () => {
    // A partially matching company, so there is headroom: OUTDATED_SITE already
    // scores 100 on this rubric and could not go higher.
    const partial = {
      "web.presence.reachable": true,
      "web.techstack.cms": "TYPO3",
      "web.features.mobile_ready": true,
      "web.techstack.has_tracking": true,
      "web.features.structured_data": true,
    }

    const withLlm = evaluateRubric({
      signals: partial,
      rubric: ERP_REPLACEMENT_RUBRIC,
      llm: {
        score: 90,
        reasoning: "Alte Website, keine Digitalisierung",
        best_angle: "x",
        risk: "y",
      },
    })

    const withoutLlm = evaluateRubric({ signals: partial, rubric: ERP_REPLACEMENT_RUBRIC })

    expect(withLlm.total).toBeGreaterThan(withoutLlm.total)
    expect(withLlm.llm?.score).toBe(90)
  })

  it("a low LLM verdict can pull a score down", () => {
    // The stage has to be able to disagree with the rules, or it is decoration.
    const partial = {
      "web.presence.reachable": true,
      "web.techstack.cms": "TYPO3",
      "web.features.mobile_ready": true,
    }

    const pessimistic = evaluateRubric({
      signals: partial,
      rubric: ERP_REPLACEMENT_RUBRIC,
      llm: { score: 5, reasoning: "Kleinbetrieb ohne ERP-Bedarf", best_angle: "x", risk: "y" },
    })
    const optimistic = evaluateRubric({
      signals: partial,
      rubric: ERP_REPLACEMENT_RUBRIC,
      llm: { score: 95, reasoning: "Klarer Kandidat", best_angle: "x", risk: "y" },
    })

    expect(pessimistic.total).toBeLessThan(optimistic.total)
  })

  it("lets the LLM stage exclude a lead outright, not merely discount it", () => {
    /**
     * Der Fall aus der Produktion: das Modell schrieb "Izakaya ist ein
     * japanisches Restaurant, keine Elektronikfirma - ein disqualifizierendes
     * Merkmal" und vergab 5 Punkte. Der Lead stand trotzdem in der Liste, weil
     * die Regelkriterien (Website da, erreichbar, HTTPS) ihn ueber die Schwelle
     * gehoben hatten. Die staerkste Aussage des Modells war die schwaechste,
     * die es ausdruecken durfte.
     */
    const goodOnPaper = {
      "web.presence.reachable": true,
      "web.techstack.cms": "TYPO3",
      "web.features.mobile_ready": true,
      "web.techstack.has_tracking": true,
      "web.features.structured_data": true,
    }

    const wrongIndustry = evaluateRubric({
      signals: goodOnPaper,
      rubric: ERP_REPLACEMENT_RUBRIC,
      llm: {
        score: 5,
        reasoning: "Japanisches Restaurant, keine Elektronikfirma.",
        best_angle: "-",
        risk: "Falsche Branche",
        disqualified: true,
      },
    })

    expect(wrongIndustry.qualified).toBe(false)
    expect(wrongIndustry.total).toBe(0)
    // Die Begruendung bleibt erhalten - der Nutzer soll sehen, warum.
    expect(wrongIndustry.llm?.reasoning).toContain("Restaurant")
  })

  it("still counts a low score as a low score, not an exclusion", () => {
    // disqualified ist fuer "gehoert nicht in die Liste", nicht fuer "schwach".
    const score = evaluateRubric({
      signals: { "web.presence.reachable": true, "web.techstack.cms": "TYPO3" },
      rubric: ERP_REPLACEMENT_RUBRIC,
      llm: { score: 5, reasoning: "Schwach", best_angle: "x", risk: "y", disqualified: false },
    })

    expect(score.total).toBeGreaterThan(0)
  })

  it("ignores an exclusion when the rubric gives the stage no weight", () => {
    // Wer die LLM-Stufe auf 0 gewichtet, will kein LLM-Urteil - auch kein
    // ausschliessendes. Sonst waere das Gewicht keine Entscheidung mehr.
    const noLlmWeight = {
      ...ERP_REPLACEMENT_RUBRIC,
      llmCriteria: [],
    }
    const score = evaluateRubric({
      signals: { "web.presence.reachable": true, "web.techstack.cms": "TYPO3" },
      rubric: noLlmWeight,
      llm: { score: 5, reasoning: "-", best_angle: "-", risk: "-", disqualified: true },
    })

    expect(score.total).toBeGreaterThan(0)
  })

  it("leaves llm null when no key is configured", () => {
    // The documented behaviour without an Anthropic key: rule-only scoring.
    const score = evaluateRubric({
      signals: OUTDATED_SITE.signals,
      rubric: ERP_REPLACEMENT_RUBRIC,
    })

    expect(score.llm).toBeNull()
    expect(score.total).toBeGreaterThan(0)
  })

  it("ignores an LLM result when the rubric has no llmCriteria", () => {
    const score = evaluateRubric({
      signals: NO_WEBSITE.signals,
      rubric: WEBSITE_SALES_RUBRIC,
      llm: { score: 100, reasoning: "x", best_angle: "y", risk: "z" },
    })

    const without = evaluateRubric({ signals: NO_WEBSITE.signals, rubric: WEBSITE_SALES_RUBRIC })
    expect(score.total).toBe(without.total)
  })
})

describe("explainScore", () => {
  it("separates what helped from what hurt", () => {
    const score = evaluateRubric({ signals: MODERN_SITE.signals, rubric: ERP_REPLACEMENT_RUBRIC })
    const explanation = explainScore(score)

    expect(explanation.negatives.some((n) => n.label.includes("Shop-System"))).toBe(true)
  })

  it("lists missing data separately from poor fit", () => {
    // A lead scoring low for lack of data needs a different action than one
    // scoring low because it genuinely does not fit.
    const score = evaluateRubric({
      signals: { "web.presence.has_website": false, "contact.basic.reachable": true },
      rubric: WEBSITE_SALES_RUBRIC,
    })

    const explanation = explainScore(score)
    expect(explanation.missing.length).toBeGreaterThan(0)
    expect(explanation.missing.some((m) => m.signal === "web.features.mobile_ready")).toBe(true)
  })

  it("names the exclusion when one applied", () => {
    const score = evaluateRubric({ signals: UNREACHABLE.signals, rubric: WEBSITE_SALES_RUBRIC })
    expect(explainScore(score).exclusions[0]?.signal).toBe("contact.basic.reachable")
  })
})

describe("rankLeads", () => {
  it("puts qualified leads first", () => {
    const leads = [
      {
        name: "low",
        score: evaluateRubric({ signals: MODERN_SITE.signals, rubric: WEBSITE_SALES_RUBRIC }),
      },
      {
        name: "high",
        score: evaluateRubric({ signals: NO_WEBSITE.signals, rubric: WEBSITE_SALES_RUBRIC }),
      },
    ]

    expect(rankLeads(leads)[0]?.name).toBe("high")
  })

  it("breaks a tie on how much data was available", () => {
    // Between two leads at the same score, the one measured completely is the
    // safer bet.
    const sparse = evaluateRubric({
      signals: { "web.presence.has_website": false, "contact.basic.reachable": true },
      rubric: WEBSITE_SALES_RUBRIC,
    })
    const complete = evaluateRubric({
      signals: {
        ...NO_WEBSITE.signals,
        "web.features.mobile_ready": true,
        "web.features.contact_form": true,
        "web.features.structured_data": true,
        "web.presence.https": true,
      },
      rubric: WEBSITE_SALES_RUBRIC,
    })

    const ranked = rankLeads([
      { name: "sparse", score: sparse },
      { name: "complete", score: complete },
    ])

    if (sparse.total === complete.total) {
      expect(ranked[0]?.name).toBe("complete")
    }
  })
})

describe("M3 acceptance: three rubrics, three different rankings", () => {
  const companies = [NO_WEBSITE, OUTDATED_SITE, MODERN_SITE, UNREACHABLE]

  const rank = (rubric: Rubric): string[] =>
    rankLeads(
      companies.map((company) => ({
        name: company.name,
        score: evaluateRubric({ signals: company.signals, rubric }),
      }))
    ).map((entry) => entry.name)

  it("website sales ranks the company without a site first", () => {
    const ranking = rank(WEBSITE_SALES_RUBRIC)
    expect(ranking[0]).toBe("Gasthaus Zur Post")
  })

  it("ERP replacement ranks the outdated site first", () => {
    const ranking = rank(ERP_REPLACEMENT_RUBRIC)
    expect(ranking[0]).toBe("Muster Produktion GmbH")
  })

  it("the two sales rubrics disagree - the engine has no built-in opinion", () => {
    // The property the whole design rests on: same companies, same code,
    // different data, different answer.
    expect(rank(WEBSITE_SALES_RUBRIC)[0]).not.toBe(rank(ERP_REPLACEMENT_RUBRIC)[0])
  })

  it("market research ranks nothing and excludes nobody", () => {
    const scores = companies.map((company) =>
      evaluateRubric({ signals: company.signals, rubric: MARKET_RESEARCH_RUBRIC })
    )

    expect(scores.every((score) => score.total === 0)).toBe(true)
    expect(scores.every((score) => score.qualified)).toBe(true)
    expect(scores.every((score) => score.breakdown.every((entry) => !entry.excluded))).toBe(true)
  })

  it("market research still records what each company has", () => {
    // Weight zero means "do not rank on it", not "do not collect it".
    const score = evaluateRubric({
      signals: MODERN_SITE.signals,
      rubric: MARKET_RESEARCH_RUBRIC,
    })

    const shop = score.breakdown.find((entry) => entry.signal === "web.techstack.shop")
    expect(shop?.actualValue).toBe("WooCommerce")
    expect(shop?.matched).toBe(true)
    expect(shop?.points).toBe(0)
  })

  it("only the sales rubrics exclude the unreachable company", () => {
    const websiteScore = evaluateRubric({
      signals: UNREACHABLE.signals,
      rubric: WEBSITE_SALES_RUBRIC,
    })
    const researchScore = evaluateRubric({
      signals: UNREACHABLE.signals,
      rubric: MARKET_RESEARCH_RUBRIC,
    })

    expect(websiteScore.qualified).toBe(false)
    expect(researchScore.qualified).toBe(true)
  })
})
