import { describe, expect, it } from "vitest"
import { collectFilterKeys, type SearchSpec } from "@alg/shared"
import {
  applyAnswer,
  applyDefaults,
  isRunnable,
  MAX_QUESTIONS,
  nextQuestions,
  startClarification,
} from "../questions.js"

/**
 * The wizard's job is to turn "Handwerksbetriebe in OÖ" into a runnable spec
 * without interrogating the user. Most of what is tested here is restraint:
 * asking few enough questions, not re-asking, and never quietly narrowing a
 * search the user did not narrow.
 */

function keysOf(spec: SearchSpec): string[] {
  return collectFilterKeys(spec.filters)
}

describe("nextQuestions", () => {
  it("never asks more than four", () => {
    // The cap is the design: a wizard that asks eleven questions gets abandoned.
    const questions = nextQuestions(startClarification("irgendwas"))
    expect(questions.length).toBeLessThanOrEqual(MAX_QUESTIONS)
  })

  it("asks about the region first", () => {
    // Without a geographic constraint Overpass refuses outright and Places
    // returns the whole world, so this is the answer that matters most.
    const questions = nextQuestions(startClarification("Handwerksbetriebe"))
    expect(questions[0]?.id).toBe("region")
  })

  it("does not ask what the spec already says", () => {
    const state = applyAnswer(startClarification("Tischlereien"), {
      questionId: "region",
      value: "oberoesterreich",
    })

    expect(nextQuestions(state).map((q) => q.id)).not.toContain("region")
  })

  it("stops asking once everything is answered", () => {
    let state = startClarification("Tischlereien in Wels")
    for (const answer of [
      { questionId: "region", value: "oberoesterreich" },
      { questionId: "category", value: ["craft_business"] },
      { questionId: "website", value: "without" },
      { questionId: "limit", value: 200 },
    ]) {
      state = applyAnswer(state, answer)
    }

    expect(nextQuestions(state)).toStrictEqual([])
  })

  it("offers only categories that suit the target type", () => {
    const company = nextQuestions(startClarification("x", "company")).find(
      (q) => q.id === "category"
    )
    const local = nextQuestions(startClarification("x", "local_business")).find(
      (q) => q.id === "category"
    )

    expect(company?.options?.map((o) => o.value)).toContain("craft_business")
    expect(company?.options?.map((o) => o.value)).not.toContain("restaurant")
    expect(local?.options?.map((o) => o.value)).toContain("restaurant")
  })

  it("gives every question a default except the category", () => {
    // Guessing an industry would silently narrow the search to something the
    // user never said. Every other question can be skipped safely.
    const questions = nextQuestions(startClarification("x"))

    for (const question of questions) {
      if (question.id === "category") {
        expect(question.defaultValue).toBeNull()
      } else {
        expect(question.defaultValue).not.toBeNull()
      }
    }
  })

  it("uses only i18n keys, never German strings", () => {
    // User-visible strings belong to the frontend; a German string here would
    // be untranslatable and would break the other repository.
    const questions = nextQuestions(startClarification("x"))

    for (const question of questions) {
      expect(question.promptKey).toMatch(/^clarify\./)
      expect(question.reasonKey).toMatch(/^clarify\./)
      for (const option of question.options ?? []) {
        expect(option.labelKey).toMatch(/^(clarify|category)\./)
      }
    }
  })

  it("declares a type the UI can render for each question", () => {
    const types = nextQuestions(startClarification("x")).map((q) => q.type)
    expect(types).toContain("single_select")
    expect(types).toContain("multi_select")
    expect(types).toContain("boolean_or_both")
  })
})

describe("applyAnswer", () => {
  it("turns a region into a bounding box", () => {
    const state = applyAnswer(startClarification("x"), {
      questionId: "region",
      value: "oberoesterreich",
    })

    expect(keysOf(state.spec)).toContain("core.geo")
    expect(isRunnable(state.spec)).toBe(true)
  })

  it("turns one category into eq and several into in", () => {
    const one = applyAnswer(startClarification("x"), {
      questionId: "category",
      value: ["craft_business"],
    })
    const many = applyAnswer(startClarification("x"), {
      questionId: "category",
      value: ["craft_business", "industrial"],
    })

    expect(JSON.stringify(one.spec.filters)).toContain('"op":"eq"')
    expect(JSON.stringify(many.spec.filters)).toContain('"op":"in"')
  })

  it("adds nothing for 'both' on the website question", () => {
    // Referencing the signal is what makes the crawler run, so a no-op answer
    // has to stay a no-op - otherwise "I don't care" costs a crawl per company.
    const state = applyAnswer(startClarification("x"), {
      questionId: "website",
      value: "both",
    })

    expect(keysOf(state.spec)).not.toContain("web.presence.has_website")
  })

  it("adds the signal filter for 'without'", () => {
    const state = applyAnswer(startClarification("x"), {
      questionId: "website",
      value: "without",
    })

    expect(keysOf(state.spec)).toContain("web.presence.has_website")
  })

  it("accumulates answers instead of replacing the spec", () => {
    let state = startClarification("x")
    state = applyAnswer(state, { questionId: "region", value: "salzburg" })
    state = applyAnswer(state, { questionId: "category", value: ["industrial"] })

    expect(keysOf(state.spec)).toStrictEqual(["core.geo", "core.category"])
  })

  it("keeps an existing OR branch intact", () => {
    // Flattening it into the new AND would change what the search means.
    const base = startClarification("x")
    const withOr: typeof base = {
      ...base,
      spec: {
        ...base.spec,
        filters: {
          op: "or",
          children: [
            { op: "eq", key: "core.city", value: "Linz" },
            { op: "eq", key: "core.city", value: "Wels" },
          ],
        },
      },
    }

    const state = applyAnswer(withOr, { questionId: "category", value: ["industrial"] })
    const json = JSON.stringify(state.spec.filters)

    expect(json).toContain('"op":"or"')
    expect(json).toContain("core.category")
  })

  it("ignores a rubbish limit rather than defaulting it", () => {
    const state = applyAnswer(startClarification("x"), { questionId: "limit", value: "viele" })
    expect(state.spec.limit).toBeUndefined()
  })

  it("records an unknown question without changing the spec", () => {
    // The frontend may be a version ahead. Dropping the answer beats throwing.
    const before = startClarification("x")
    const after = applyAnswer(before, { questionId: "favourite_colour", value: "blau" })

    expect(after.spec).toStrictEqual(before.spec)
    expect(after.answers.favourite_colour).toBe("blau")
  })

  it("does not mutate the state it was given", () => {
    const before = startClarification("x")
    const snapshot = JSON.stringify(before)
    applyAnswer(before, { questionId: "region", value: "tirol" })

    expect(JSON.stringify(before)).toBe(snapshot)
  })
})

describe("applyDefaults", () => {
  it("produces a runnable search from no answers at all", () => {
    // This is what makes the wizard skippable: press run at any point and get a
    // search built from documented defaults rather than an error.
    const state = applyDefaults(startClarification("Handwerksbetriebe"))

    expect(isRunnable(state.spec)).toBe(true)
    expect(state.spec.limit).toBe(500)
  })

  it("does not invent a category", () => {
    const state = applyDefaults(startClarification("x"))
    expect(keysOf(state.spec)).not.toContain("core.category")
  })

  it("does not add a website filter, so the default search stays free", () => {
    // The default has to cost nothing: an unanswered question must not trigger
    // a provider run per company.
    const state = applyDefaults(startClarification("x"))
    expect(keysOf(state.spec)).not.toContain("web.presence.has_website")
  })

  it("leaves answers the user did give alone", () => {
    const answered = applyAnswer(startClarification("x"), {
      questionId: "region",
      value: "tirol",
    })
    const filled = applyDefaults(answered)

    expect(filled.answers.region).toBe("tirol")
    expect(JSON.stringify(filled.spec.filters)).toContain("46.65")
  })
})

describe("isRunnable", () => {
  it("is false without any geographic constraint", () => {
    expect(isRunnable(startClarification("x").spec)).toBe(false)
  })

  it("accepts a city as well as a bounding box", () => {
    const spec: SearchSpec = {
      targetType: "company",
      filters: { op: "and", children: [{ op: "eq", key: "core.city", value: "Wels" }] },
    }
    expect(isRunnable(spec)).toBe(true)
  })
})
