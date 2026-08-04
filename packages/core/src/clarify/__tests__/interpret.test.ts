import { describe, expect, it, vi } from "vitest"
import { categoriesFor } from "@alg/shared"
import { type LlmClient } from "../../scoring/llm-client.js"
import { interpretSearch } from "../interpret.js"
import { KNOWN_REGIONS, applyInterpretation, startClarification } from "../questions.js"

/**
 * Der Suchtext wurde bis hierher gespeichert und nie gelesen: wer "Baufirmen in
 * Linz" eintippte, wurde danach gefragt, in welcher Region er suchen wolle.
 */

function fakeClient(value: unknown): LlmClient {
  return {
    completeJson: vi.fn(async () => ({
      value,
      usage: { inputTokens: 100, outputTokens: 50 },
    })),
  }
}

const BASE = {
  categories: categoriesFor("company"),
  regions: KNOWN_REGIONS,
  description: "Baufirmen in Linz mit unter 50 Mitarbeitern",
}

describe("interpretSearch", () => {
  it("reads region, city and category out of one sentence", async () => {
    const result = await interpretSearch({
      ...BASE,
      client: fakeClient({
        region: "oberoesterreich",
        city: "Linz",
        categories: ["craft_business"],
        target_type: "company",
        limit: null,
        for_rubric: ["Weniger als 50 Mitarbeiter"],
        summary: "Baufirmen im Raum Linz mit weniger als 50 Mitarbeitern.",
      }),
    })

    expect(result.region).toBe("oberoesterreich")
    expect(result.city).toBe("Linz")
    expect(result.categories).toStrictEqual(["craft_business"])
  })

  it("keeps what no source can filter instead of dropping it", async () => {
    // Die Mitarbeiterzahl kann keine Quelle vorfiltern. Sie wegzulassen waere
    // schlimmer als sie zu behalten: der Nutzer hat sie genannt und wuerde
    // annehmen, sie sei beruecksichtigt.
    const result = await interpretSearch({
      ...BASE,
      client: fakeClient({
        region: "oberoesterreich",
        city: "Linz",
        categories: [],
        target_type: null,
        limit: null,
        for_rubric: ["Weniger als 50 Mitarbeiter"],
        summary: "…",
      }),
    })

    expect(result.forRubric).toStrictEqual(["Weniger als 50 Mitarbeiter"])
  })

  it("drops a category slug the catalog does not contain", async () => {
    // Das enum im Schema ist eine Bitte, keine Garantie - ein durchgerutschter
    // Slug fuehrt still zu null Treffern.
    const result = await interpretSearch({
      ...BASE,
      client: fakeClient({
        region: null,
        city: null,
        categories: ["baufirma", "craft_business"],
        target_type: null,
        limit: null,
        for_rubric: [],
        summary: "…",
      }),
    })

    expect(result.categories).toStrictEqual(["craft_business"])
  })

  it("drops a region that is not in the list", async () => {
    const result = await interpretSearch({
      ...BASE,
      client: fakeClient({
        region: "bayern",
        city: null,
        categories: [],
        target_type: null,
        limit: null,
        for_rubric: [],
        summary: "…",
      }),
    })

    expect(result.region).toBeNull()
  })

  it("caps an absurd limit rather than passing it through", async () => {
    const result = await interpretSearch({
      ...BASE,
      client: fakeClient({
        region: null,
        city: null,
        categories: [],
        target_type: null,
        limit: 999_999,
        for_rubric: [],
        summary: "…",
      }),
    })

    expect(result.limit).toBe(5000)
  })
})

describe("applyInterpretation", () => {
  it("stops the wizard from asking what the user already typed", () => {
    const before = startClarification("Baufirmen in Linz", "company")
    const after = applyInterpretation(before, {
      region: "oberoesterreich",
      city: "Linz",
      categories: ["craft_business"],
      limit: null,
    })

    const keys = JSON.stringify(after.spec.filters)
    expect(keys).toContain("core.geo")
    expect(keys).toContain("core.category")
    expect(keys).toContain("core.city")
  })

  it("treats a postal code as a postal code", () => {
    // "4020" als Ortsname gesucht faende nichts.
    const after = applyInterpretation(startClarification("Firmen in 4020", "company"), {
      region: null,
      city: "4020",
      categories: [],
      limit: null,
    })

    expect(JSON.stringify(after.spec.filters)).toContain("core.postal_code")
  })

  it("changes nothing when the text carried no parameters", () => {
    const before = startClarification("Irgendwas", "company")
    const after = applyInterpretation(before, {
      region: null,
      city: null,
      categories: [],
      limit: null,
    })

    expect(after.spec).toStrictEqual(before.spec)
  })
})
