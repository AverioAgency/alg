import {
  type LeadScore,
  type Rubric,
  type RubricCriterion,
  type ScoreBreakdownEntry,
} from "@alg/shared"
import { evaluateFilter } from "../discovery/filter-eval.js"

/**
 * Turns signals into a score using a rubric.
 *
 * Every criterion produces a breakdown entry whether it matched or not. A score
 * without that breakdown is unusable: the user has to see why a lead ranks where
 * it does, and "not measured" has to stay distinguishable from "measured as
 * false" - otherwise a failed crawl silently looks like a disqualifying answer.
 *
 * The rubric is data. Nothing here knows what a good lead is; it only applies
 * what the user configured.
 */

export interface EvaluateOptions {
  /** Flat map of signal key -> value, as the enrichment layer stores it. */
  signals: Record<string, unknown>
  rubric: Rubric
  /** Result of the LLM stage, when one ran. */
  llm?: LeadScore["llm"]
}

/**
 * Normalizes the raw weighted sum onto 0..100.
 *
 * Without this a rubric with three criteria and one with thirty would produce
 * incomparable numbers, and the threshold would have to be retuned every time a
 * criterion is added. The denominator is the sum of positive weights - the best
 * a lead could possibly do.
 */
function normalize(raw: number, maxPossible: number): number {
  if (maxPossible <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((raw / maxPossible) * 100)))
}

export function evaluateRubric(options: EvaluateOptions): LeadScore {
  const { signals, rubric } = options
  const breakdown: ScoreBreakdownEntry[] = []

  let raw = 0
  let maxPossible = 0
  let excluded = false

  for (const criterion of rubric.criteria) {
    const entry = evaluateCriterion(criterion, signals)
    breakdown.push(entry)

    // A hard criterion that fails removes the lead entirely. Its points do not
    // matter after that, but the breakdown still records why.
    if (entry.excluded) {
      excluded = true
      continue
    }

    raw += entry.points
    if (criterion.weight > 0) maxPossible += criterion.weight
  }

  // The LLM stage contributes on the same 0..100 scale as the rules, weighted
  // by how much the rubric says it should count.
  const llmWeight = (rubric.llmCriteria ?? []).reduce((sum, c) => sum + c.weight, 0)
  if (options.llm && llmWeight > 0) {
    const llmScore = Math.max(0, Math.min(100, options.llm.score))
    raw += (llmScore / 100) * llmWeight
    maxPossible += llmWeight
  }

  const total = excluded ? 0 : normalize(raw, maxPossible)

  return {
    total,
    qualified: !excluded && total >= rubric.threshold,
    threshold: rubric.threshold,
    breakdown,
    llm: options.llm ?? null,
  }
}

function evaluateCriterion(
  criterion: RubricCriterion,
  signals: Record<string, unknown>
): ScoreBreakdownEntry {
  const present = Object.prototype.hasOwnProperty.call(signals, criterion.signal)
  const actual = present ? signals[criterion.signal] : null

  // A signal that was never computed must not count as a failed criterion: a
  // provider that timed out would otherwise look like a disqualifying answer.
  if (!present || actual === undefined) {
    return {
      label: criterion.label,
      signal: criterion.signal,
      actualValue: null,
      matched: false,
      weight: criterion.weight,
      points: 0,
      hard: criterion.hard,
      excluded: false,
    }
  }

  // Reuses the filter evaluator so a condition means exactly the same thing in a
  // rubric as it does in a search.
  const matched = evaluateFilter(
    { op: criterion.condition.op, key: criterion.signal, value: criterion.condition.value },
    signals
  )

  return {
    label: criterion.label,
    signal: criterion.signal,
    actualValue: actual,
    matched,
    weight: criterion.weight,
    points: matched ? criterion.weight : 0,
    hard: criterion.hard,
    // Hard criteria exclude when they do NOT match: they express a requirement,
    // not a bonus.
    excluded: criterion.hard && !matched,
  }
}

/**
 * Explains a score in German, for the UI and reports.
 *
 * Returns i18n-ready parts rather than a finished sentence, so the frontend
 * decides on wording and the backend stays free of hardcoded German.
 */
export interface ScoreExplanation {
  totalKey: string
  qualified: boolean
  positives: { label: string; points: number }[]
  negatives: { label: string; points: number }[]
  missing: { label: string; signal: string }[]
  exclusions: { label: string; signal: string }[]
}

export function explainScore(score: LeadScore): ScoreExplanation {
  return {
    totalKey: score.qualified ? "score.qualified" : "score.below_threshold",
    qualified: score.qualified,
    positives: score.breakdown
      .filter((entry) => entry.matched && entry.points > 0)
      .map((entry) => ({ label: entry.label, points: entry.points }))
      .sort((a, b) => b.points - a.points),
    negatives: score.breakdown
      .filter((entry) => entry.matched && entry.points < 0)
      .map((entry) => ({ label: entry.label, points: entry.points }))
      .sort((a, b) => a.points - b.points),
    // Surfaced separately: a lead scoring low because data is missing needs a
    // different action than one scoring low because it genuinely does not fit.
    missing: score.breakdown
      .filter((entry) => entry.actualValue === null && !entry.excluded)
      .map((entry) => ({ label: entry.label, signal: entry.signal })),
    exclusions: score.breakdown
      .filter((entry) => entry.excluded)
      .map((entry) => ({ label: entry.label, signal: entry.signal })),
  }
}

/**
 * Ranks leads by score.
 *
 * Ties break on how much of the rubric could actually be evaluated: between two
 * leads at 60, the one with complete data is the safer bet.
 */
export function rankLeads<T extends { score: LeadScore }>(leads: readonly T[]): T[] {
  return [...leads].sort((a, b) => {
    if (a.score.qualified !== b.score.qualified) return a.score.qualified ? -1 : 1
    if (a.score.total !== b.score.total) return b.score.total - a.score.total

    const coverage = (score: LeadScore): number =>
      score.breakdown.filter((entry) => entry.actualValue !== null).length
    return coverage(b.score) - coverage(a.score)
  })
}
