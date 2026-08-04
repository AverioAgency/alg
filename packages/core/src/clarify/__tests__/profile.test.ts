import { describe, expect, it } from "vitest"
import { collectFilterKeys, type OnboardingProfile } from "@alg/shared"
import { applyProfile, nextQuestions, startClarification } from "../questions.js"

/**
 * What onboarding recorded has to change later searches, otherwise filling in
 * the wizard bought the user nothing. These tests are about that: the answers
 * carry over, they do not have to be given twice, and the ones that are
 * per-search decisions deliberately do not carry over at all.
 */

const PROFILE: OnboardingProfile = {
  company: { name: "Averio", industry: "Agentur" },
  offer: { description: "Websites für Handwerksbetriebe" },
  target: {
    targetType: "company",
    region: "oberoesterreich",
    categories: ["craft_business", "industrial"],
  },
  completedAt: "2026-08-04T08:00:00.000Z",
}

describe("a profile pre-fills a search", () => {
  it("carries the region over, so it is not asked again", () => {
    const state = startClarification("Handwerksbetriebe", "company", PROFILE)

    expect(collectFilterKeys(state.spec.filters)).toContain("core.geo")
    expect(nextQuestions(state).map((q) => q.id)).not.toContain("region")
  })

  it("carries the categories over", () => {
    const state = startClarification("Betriebe", "company", PROFILE)

    expect(collectFilterKeys(state.spec.filters)).toContain("core.category")
    expect(nextQuestions(state).map((q) => q.id)).not.toContain("category")
  })

  it("makes a bare description runnable straight away", () => {
    // The practical payoff: after onboarding, typing a sentence is enough - no
    // geographic constraint to supply, which Overpass would otherwise refuse.
    const withProfile = startClarification("Tischlereien", "company", PROFILE)
    const without = startClarification("Tischlereien", "company")

    expect(nextQuestions(withProfile).length).toBeLessThan(nextQuestions(without).length)
  })

  it("takes the target type from the profile", () => {
    const state = startClarification("x", "local_business", PROFILE)
    expect(state.targetType).toBe("company")
  })

  it("does not carry the website question over", () => {
    // A per-search decision: wanting leads without a website today says nothing
    // about tomorrow, and it is the answer that decides whether the crawl runs
    // at all - so it must stay an explicit choice each time.
    const state = startClarification("x", "company", PROFILE)
    expect(nextQuestions(state).map((q) => q.id)).toContain("website")
  })

  it("does not carry a limit over", () => {
    // A stored limit would silently cap searches the user did not mean to cap.
    const state = startClarification("x", "company", PROFILE)
    expect(state.spec.limit).toBeUndefined()
  })
})

describe("an incomplete or absent profile", () => {
  it("changes nothing when there is none", () => {
    const withNull = startClarification("x", "company", null)
    const without = startClarification("x", "company")

    expect(withNull.spec).toStrictEqual(without.spec)
  })

  it("applies only what the half-finished profile actually says", () => {
    // Abandoning the wizard at step 2 is normal; what was answered still counts.
    const partial: OnboardingProfile = { target: { region: "tirol" } }
    const state = startClarification("x", "company", partial)

    const remaining = nextQuestions(state).map((q) => q.id)
    expect(remaining).not.toContain("region")
    expect(remaining).toContain("category")
  })

  it("ignores an empty category list rather than filtering on nothing", () => {
    const empty: OnboardingProfile = { target: { region: "wien", categories: [] } }
    const state = startClarification("x", "company", empty)

    expect(collectFilterKeys(state.spec.filters)).not.toContain("core.category")
  })

  it("ignores a region the question vocabulary does not know", () => {
    // A stale slug from an older frontend must not produce a broken filter.
    const stale: OnboardingProfile = { target: { region: "atlantis" } }
    const state = startClarification("x", "company", stale)

    expect(collectFilterKeys(state.spec.filters)).not.toContain("core.geo")
  })
})

describe("the user's own answers win", () => {
  it("does not ask a question the profile already answered, and keeps that answer", () => {
    const state = startClarification("x", "company", PROFILE)
    // Tirol would have to be applied on top of the profile's Oberösterreich,
    // and the applied answer is what the spec shows.
    const overridden = applyProfile(state, { target: { region: "tirol" } })

    // Both regions are in the tree; the search widens rather than silently
    // dropping one - narrowing would discard a filter the user did choose.
    expect(JSON.stringify(overridden.spec.filters)).toContain("46.65")
  })

  it("leaves the state untouched when the profile says nothing", () => {
    const before = startClarification("x", "company")
    const after = applyProfile(before, {})

    expect(after.spec).toStrictEqual(before.spec)
  })
})
