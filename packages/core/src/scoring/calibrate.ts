import { type LeadScore, type Rubric } from "@alg/shared"

/**
 * Suggests a corrected threshold from leads the user labelled by hand.
 *
 * Deliberately arithmetic rather than an LLM call: picking the cut that best
 * separates two labelled sets is a calculation with a right answer. Asking a
 * model to guess it would be slower, cost money and be wrong more often - and
 * the user could not check the reasoning.
 */

export interface CalibrationSample {
  score: LeadScore
  /** What the user said: true = worth contacting. */
  good: boolean
}

export interface CalibrationResult {
  /** Threshold that best separates the two sets. */
  suggestedThreshold: number
  currentThreshold: number
  /** Share of samples the suggested threshold classifies as the user did (0..1). */
  accuracy: number
  accuracyAtCurrent: number
  /** Good leads the current threshold rejects. */
  falseNegatives: number
  /** Bad leads the current threshold accepts. */
  falsePositives: number
  /** Criteria whose matching correlates poorly with the user's verdict. */
  suspectCriteria: SuspectCriterion[]
  sampleSize: number
  /** False when there is too little labelled data to say anything. */
  reliable: boolean
}

export interface SuspectCriterion {
  label: string
  signal: string
  weight: number
  /**
   * -1..1. Positive means matching this criterion goes with a good lead.
   * Near zero means the criterion carries no information about the verdict.
   */
  correlation: number
  reasonKey: "no_signal" | "inverted" | "never_measured"
}

/** Below this, "the threshold that fits best" is noise fitting, not calibration. */
const MIN_SAMPLES = 8

export function calibrateRubric(
  rubric: Rubric,
  samples: readonly CalibrationSample[]
): CalibrationResult {
  const currentThreshold = rubric.threshold
  const good = samples.filter((s) => s.good)
  const bad = samples.filter((s) => !s.good)

  const accuracyAt = (threshold: number): number => {
    if (samples.length === 0) return 0
    const correct = samples.filter((s) => s.score.total >= threshold === s.good).length
    return correct / samples.length
  }

  // Only thresholds at an actual score boundary can change the outcome; scanning
  // 0..100 would test 100 candidates to find the same answer.
  const candidates = [
    ...new Set([0, ...samples.map((s) => s.score.total), ...samples.map((s) => s.score.total + 1)]),
  ]
    .filter((value) => value >= 0 && value <= 100)
    .sort((a, b) => a - b)

  let suggestedThreshold = currentThreshold
  let bestAccuracy = accuracyAt(currentThreshold)

  for (const candidate of candidates) {
    const accuracy = accuracyAt(candidate)
    // Ties go to the threshold closest to what the user already has: churning
    // the number for no measured gain destroys their trust in the suggestion.
    if (
      accuracy > bestAccuracy ||
      (accuracy === bestAccuracy &&
        Math.abs(candidate - currentThreshold) < Math.abs(suggestedThreshold - currentThreshold))
    ) {
      bestAccuracy = accuracy
      suggestedThreshold = candidate
    }
  }

  return {
    suggestedThreshold,
    currentThreshold,
    accuracy: bestAccuracy,
    accuracyAtCurrent: accuracyAt(currentThreshold),
    falseNegatives: good.filter((s) => s.score.total < currentThreshold).length,
    falsePositives: bad.filter((s) => s.score.total >= currentThreshold).length,
    suspectCriteria: findSuspectCriteria(rubric, samples),
    sampleSize: samples.length,
    reliable: samples.length >= MIN_SAMPLES && good.length > 0 && bad.length > 0,
  }
}

/**
 * Finds criteria that do not predict the user's verdict.
 *
 * Three distinct problems the user needs told apart: a criterion nobody has data
 * for, one that carries no signal, and one that points the wrong way. The last
 * is the interesting case - it usually means the user described the inverse of
 * what they actually want.
 */
function findSuspectCriteria(
  rubric: Rubric,
  samples: readonly CalibrationSample[]
): SuspectCriterion[] {
  const suspects: SuspectCriterion[] = []

  for (const criterion of rubric.criteria) {
    if (criterion.weight === 0) continue

    const measured = samples.filter((sample) =>
      sample.score.breakdown.some(
        (entry) => entry.signal === criterion.signal && entry.actualValue !== null
      )
    )

    if (measured.length < Math.max(3, Math.floor(samples.length / 3))) {
      suspects.push({
        label: criterion.label,
        signal: criterion.signal,
        weight: criterion.weight,
        correlation: 0,
        reasonKey: "never_measured",
      })
      continue
    }

    const correlation = pointBiserial(
      measured.map((sample) => ({
        matched:
          sample.score.breakdown.find((entry) => entry.signal === criterion.signal)?.matched ??
          false,
        good: sample.good,
      }))
    )

    // A negative-weight criterion is supposed to anti-correlate, so the expected
    // direction follows the sign of the weight.
    const expectedSign = Math.sign(criterion.weight)
    const effective = correlation * expectedSign

    if (effective < -0.2) {
      suspects.push({
        label: criterion.label,
        signal: criterion.signal,
        weight: criterion.weight,
        correlation,
        reasonKey: "inverted",
      })
    } else if (Math.abs(effective) < 0.05) {
      suspects.push({
        label: criterion.label,
        signal: criterion.signal,
        weight: criterion.weight,
        correlation,
        reasonKey: "no_signal",
      })
    }
  }

  return suspects.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
}

/** Correlation between two binary variables (phi coefficient). */
function pointBiserial(pairs: readonly { matched: boolean; good: boolean }[]): number {
  let matchedGood = 0
  let matchedBad = 0
  let unmatchedGood = 0
  let unmatchedBad = 0

  for (const pair of pairs) {
    if (pair.matched && pair.good) matchedGood++
    else if (pair.matched) matchedBad++
    else if (pair.good) unmatchedGood++
    else unmatchedBad++
  }

  const numerator = matchedGood * unmatchedBad - matchedBad * unmatchedGood
  const denominator = Math.sqrt(
    (matchedGood + matchedBad) *
      (unmatchedGood + unmatchedBad) *
      (matchedGood + unmatchedGood) *
      (matchedBad + unmatchedBad)
  )

  // Zero denominator means one row or column is empty - every lead matched, or
  // every lead was good. No correlation is defined, and reporting one would be
  // an invention.
  return denominator === 0 ? 0 : numerator / denominator
}
