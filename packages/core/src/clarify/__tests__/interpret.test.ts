import { describe, expect, it, vi } from "vitest"
import { categoriesFor } from "@alg/shared"
import { type LlmClient } from "../../scoring/llm-client.js"
import { interpretSearch } from "../interpret.js"
import { KNOWN_REGIONS, applyAnswer, applyInterpretation, startClarification } from "../questions.js"

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

describe("eine Branche ohne passenden Slug", () => {
  it("keeps the trade as a name filter instead of dropping it", async () => {
    /**
     * "Elektroniker" bildet auf keinen Slug ab. Ohne Ersatz fiel die Branche
     * ersatzlos weg, die Abfrage wurde zur Rundumsuche und lieferte einen Arzt,
     * zwei Supermaerkte und zwei Lokale - auf die Frage nach Elektronikern.
     */
    const result = await interpretSearch({
      ...BASE,
      description: "Elektroniker in Linz",
      client: fakeClient({
        region: "oberoesterreich",
        city: "Linz",
        categories: [],
        trade_term: "Elektro",
        target_type: null,
        limit: null,
        for_rubric: [],
        summary: "Elektrobetriebe in Linz.",
      }),
    })

    expect(result.categories).toStrictEqual([])
    expect(result.tradeTerm).toBe("Elektro")
  })

  it("becomes a core.name filter in the spec", () => {
    const after = applyInterpretation(startClarification("Elektroniker in Linz", "company"), {
      region: "oberoesterreich",
      city: "Linz",
      categories: [],
      tradeTerm: "Elektro",
      limit: null,
    })

    expect(JSON.stringify(after.spec.filters)).toContain("core.name")
  })

  it("prefers a real category over the name filter", () => {
    // Der Namensfilter ist der Notnagel, nicht die erste Wahl: er findet den
    // Betrieb nicht, der sich anders nennt.
    const after = applyInterpretation(startClarification("Tischler in Linz", "company"), {
      region: "oberoesterreich",
      city: "Linz",
      categories: ["craft_business"],
      tradeTerm: "Tischler",
      limit: null,
    })

    const filters = JSON.stringify(after.spec.filters)
    expect(filters).toContain("core.category")
    expect(filters).not.toContain("core.name")
  })
})

describe("Schichten ersetzen sich, statt sich zu stapeln", () => {
  /**
   * Nachgestellt aus einer echten Spec: Profil (ganz Oesterreich + alle 22
   * Kategorien), Interpretation (Oberoesterreich + restaurant + Linz) und
   * Antworten (Oberoesterreich + restaurant) schrieben nacheinander in
   * dieselbe Suche - alles ge-ANDet, mit zwei sich widersprechenden bboxen
   * und drei Kategoriebedingungen.
   */
  it("keeps one bbox, one category and one city across all three layers", () => {
    let state = startClarification("Restaurants in Linz", null, {
      target: {
        targetType: "local_business",
        region: "austria",
        categories: [
          "restaurant", "cafe", "bar", "hotel", "bakery", "butcher", "hairdresser",
          "supermarket", "pharmacy", "doctor", "dentist", "car_repair", "car_dealer",
          "florist", "optician", "furniture", "hardware", "clothes", "electronics",
          "craft", "gym", "veterinary",
        ],
      },
    })

    state = applyInterpretation(state, {
      region: "oberoesterreich",
      city: "Linz",
      categories: ["restaurant"],
      limit: null,
    })

    state = applyAnswer(state, { questionId: "region", value: "oberoesterreich" })
    state = applyAnswer(state, { questionId: "category", value: "restaurant" })

    const json = JSON.stringify(state.spec.filters)
    expect(json.match(/core\.geo/g)).toHaveLength(1)
    expect(json.match(/core\.category/g)).toHaveLength(1)
    expect(json.match(/core\.city/g)).toHaveLength(1)
    // Die letzte Schicht gewinnt: eine Kategorie, nicht 22.
    expect(json).toContain('"value":"restaurant"')
    expect(json).not.toContain("car_dealer")
    // Und die engere Region, nicht ganz Oesterreich.
    expect(json).not.toContain("46.37")
  })

  it("the text's trade term replaces nothing when an answer later picks a category", () => {
    // Namensfilter ist der Notnagel; eine spaeter gewaehlte Kategorie raeumt
    // ihn weg, sonst suchte die Spec Namen UND Kategorie zugleich.
    let state = applyInterpretation(startClarification("Elektroniker", null), {
      region: null,
      city: null,
      categories: [],
      tradeTerm: "Elektro",
      limit: null,
    })
    state = applyAnswer(state, { questionId: "category", value: "electronics" })

    const json = JSON.stringify(state.spec.filters)
    expect(json).not.toContain("core.name")
    expect(json).toContain("electronics")
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
