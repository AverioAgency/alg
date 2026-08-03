import { describe, expect, it } from "vitest"
import { type LeadScore, type Rubric } from "@alg/shared"
import { calibrateRubric, type CalibrationSample } from "../calibrate.js"

/**
 * Calibration works on labelled examples, so the fixtures here are scores plus
 * the user's verdict rather than companies.
 */

function score(total: number, entries: Partial<LeadScore["breakdown"][number]>[] = []): LeadScore {
  return {
    total,
    qualified: total >= 50,
    threshold: 50,
    breakdown: entries.map((entry) => ({
      label: entry.label ?? "Kriterium",
      signal: entry.signal ?? "web.presence.has_website",
      // `?? true` would swallow an explicit null, which is exactly the case the
      // "never measured" tests are about.
      actualValue: "actualValue" in entry ? entry.actualValue : true,
      matched: entry.matched ?? false,
      weight: entry.weight ?? 10,
      points: entry.points ?? 0,
      hard: entry.hard ?? false,
      excluded: entry.excluded ?? false,
    })),
    llm: null,
  }
}

const RUBRIC: Rubric = {
  criteria: [
    {
      label: "Keine Website",
      signal: "web.presence.has_website",
      condition: { op: "eq", value: false },
      weight: 40,
      hard: false,
    },
    {
      label: "Nicht mobiloptimiert",
      signal: "web.features.mobile_ready",
      condition: { op: "eq", value: false },
      weight: 20,
      hard: false,
    },
  ],
  threshold: 50,
}

/** Good leads score high, bad ones low, with the boundary at 65. */
function cleanlySeparated(): CalibrationSample[] {
  return [
    { score: score(90), good: true },
    { score: score(85), good: true },
    { score: score(80), good: true },
    { score: score(70), good: true },
    { score: score(60), good: false },
    { score: score(50), good: false },
    { score: score(40), good: false },
    { score: score(20), good: false },
  ]
}

describe("calibrateRubric", () => {
  it("moves the threshold to where the labelled sets actually separate", () => {
    const result = calibrateRubric(RUBRIC, cleanlySeparated())

    expect(result.suggestedThreshold).toBeGreaterThan(60)
    expect(result.suggestedThreshold).toBeLessThanOrEqual(70)
    expect(result.accuracy).toBe(1)
  })

  it("reports how badly the current threshold performs", () => {
    const result = calibrateRubric(RUBRIC, cleanlySeparated())

    // At 50, the two leads at 60 and 50 are accepted although the user rejected them.
    expect(result.falsePositives).toBe(2)
    expect(result.falseNegatives).toBe(0)
    expect(result.accuracyAtCurrent).toBeLessThan(result.accuracy)
  })

  it("leaves a threshold alone when it already fits", () => {
    // Churning the number for no measured gain destroys trust in the suggestion.
    const samples: CalibrationSample[] = [
      { score: score(90), good: true },
      { score: score(80), good: true },
      { score: score(70), good: true },
      { score: score(60), good: true },
      { score: score(40), good: false },
      { score: score(30), good: false },
      { score: score(20), good: false },
      { score: score(10), good: false },
    ]

    const result = calibrateRubric(RUBRIC, samples)

    expect(result.suggestedThreshold).toBe(50)
    expect(result.accuracy).toBe(1)
  })

  it("marks a result unreliable when there is too little labelled data", () => {
    // Fitting a threshold to three examples is noise fitting, and the user has
    // to be told that rather than handed a confident-looking number.
    const result = calibrateRubric(RUBRIC, [
      { score: score(90), good: true },
      { score: score(20), good: false },
      { score: score(80), good: true },
    ])

    expect(result.reliable).toBe(false)
    expect(result.sampleSize).toBe(3)
  })

  it("marks it unreliable when the user only labelled one side", () => {
    // Without a single bad example, "everything qualifies" fits perfectly and
    // means nothing.
    const result = calibrateRubric(
      RUBRIC,
      Array.from({ length: 10 }, (_, i) => ({ score: score(90 - i), good: true }))
    )

    expect(result.reliable).toBe(false)
    expect(result.accuracy).toBe(1)
  })

  it("handles an empty sample set without dividing by zero", () => {
    const result = calibrateRubric(RUBRIC, [])

    expect(result.reliable).toBe(false)
    expect(result.accuracy).toBe(0)
    expect(result.suggestedThreshold).toBe(RUBRIC.threshold)
  })
})

describe("suspect criteria", () => {
  it("flags a criterion that points the wrong way", () => {
    // Matching "keine Website" goes with a BAD verdict here - the user described
    // the inverse of what they want, which is worth telling them.
    const samples: CalibrationSample[] = [
      ...Array.from({ length: 5 }, () => ({
        score: score(80, [
          { signal: "web.presence.has_website", matched: false, label: "Keine Website" },
          { signal: "web.features.mobile_ready", matched: true, label: "Nicht mobiloptimiert" },
        ]),
        good: true,
      })),
      ...Array.from({ length: 5 }, () => ({
        score: score(30, [
          { signal: "web.presence.has_website", matched: true, label: "Keine Website" },
          { signal: "web.features.mobile_ready", matched: false, label: "Nicht mobiloptimiert" },
        ]),
        good: false,
      })),
    ]

    const result = calibrateRubric(RUBRIC, samples)
    const inverted = result.suspectCriteria.find(
      (entry) => entry.signal === "web.presence.has_website"
    )

    expect(inverted?.reasonKey).toBe("inverted")
    expect(inverted?.correlation).toBeLessThan(0)
  })

  it("flags a criterion nobody has data for", () => {
    // A different problem from a wrong criterion, and it needs a different fix:
    // the provider failed, not the rubric.
    const samples: CalibrationSample[] = Array.from({ length: 10 }, (_, i) => ({
      score: score(i * 10, [
        { signal: "web.presence.has_website", matched: true, actualValue: true },
        { signal: "web.features.mobile_ready", actualValue: null, matched: false },
      ]),
      good: i >= 5,
    }))

    const result = calibrateRubric(RUBRIC, samples)
    const never = result.suspectCriteria.find(
      (entry) => entry.signal === "web.features.mobile_ready"
    )

    expect(never?.reasonKey).toBe("never_measured")
  })

  it("flags a criterion that carries no information", () => {
    // Matches half the good and half the bad leads: it costs a provider run and
    // tells the user nothing.
    const samples: CalibrationSample[] = [
      { score: score(80, [{ signal: "web.presence.has_website", matched: true }]), good: true },
      { score: score(75, [{ signal: "web.presence.has_website", matched: false }]), good: true },
      { score: score(70, [{ signal: "web.presence.has_website", matched: true }]), good: true },
      { score: score(65, [{ signal: "web.presence.has_website", matched: false }]), good: true },
      { score: score(40, [{ signal: "web.presence.has_website", matched: true }]), good: false },
      { score: score(35, [{ signal: "web.presence.has_website", matched: false }]), good: false },
      { score: score(30, [{ signal: "web.presence.has_website", matched: true }]), good: false },
      { score: score(25, [{ signal: "web.presence.has_website", matched: false }]), good: false },
    ]

    const result = calibrateRubric(RUBRIC, samples)
    const noSignal = result.suspectCriteria.find(
      (entry) => entry.signal === "web.presence.has_website"
    )

    expect(noSignal?.reasonKey).toBe("no_signal")
  })

  it("does not flag a criterion that predicts the verdict well", () => {
    const samples: CalibrationSample[] = [
      ...Array.from({ length: 5 }, () => ({
        score: score(80, [{ signal: "web.presence.has_website", matched: true }]),
        good: true,
      })),
      ...Array.from({ length: 5 }, () => ({
        score: score(20, [{ signal: "web.presence.has_website", matched: false }]),
        good: false,
      })),
    ]

    const result = calibrateRubric(RUBRIC, samples)

    expect(
      result.suspectCriteria.find((entry) => entry.signal === "web.presence.has_website")
    ).toBeUndefined()
  })

  it("ignores zero-weight criteria", () => {
    // Market-research rubrics weight everything at zero on purpose; flagging
    // every one of them as suspect would be noise.
    const marketResearch: Rubric = {
      criteria: [
        {
          label: "Hat Website",
          signal: "web.presence.has_website",
          condition: { op: "eq", value: true },
          weight: 0,
          hard: false,
        },
      ],
      threshold: 0,
    }

    const result = calibrateRubric(
      marketResearch,
      Array.from({ length: 10 }, (_, i) => ({
        score: score(0, [{ signal: "web.presence.has_website", matched: i % 2 === 0 }]),
        good: i % 3 === 0,
      }))
    )

    expect(result.suspectCriteria).toHaveLength(0)
  })

  it("expects a negative-weight criterion to anti-correlate", () => {
    // A penalty that matches bad leads is working as intended, not inverted.
    const penalty: Rubric = {
      criteria: [
        {
          label: "Betreibt bereits einen Shop",
          signal: "web.techstack.shop",
          condition: { op: "exists", value: true },
          weight: -25,
          hard: false,
        },
      ],
      threshold: 40,
    }

    const samples: CalibrationSample[] = [
      ...Array.from({ length: 5 }, () => ({
        score: score(80, [{ signal: "web.techstack.shop", matched: false }]),
        good: true,
      })),
      ...Array.from({ length: 5 }, () => ({
        score: score(20, [{ signal: "web.techstack.shop", matched: true }]),
        good: false,
      })),
    ]

    const result = calibrateRubric(penalty, samples)

    expect(result.suspectCriteria).toHaveLength(0)
  })
})
