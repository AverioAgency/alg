import { z } from "zod"
import { OperatorSchema } from "./search.js"

export const RubricCriterionSchema = z.object({
  label: z.string().min(1),
  /** Reference to a SignalDef key. Validated against the registry at save time. */
  signal: z.string().min(1),
  condition: z.object({
    op: OperatorSchema,
    value: z.unknown(),
  }),
  /** Negative weights penalize. Zero means "compute it but do not rank on it". */
  weight: z.number().min(-100).max(100),
  /** true = failing this criterion excludes the lead outright, no partial credit. */
  hard: z.boolean().default(false),
})

export type RubricCriterion = z.infer<typeof RubricCriterionSchema>

export const LlmCriterionSchema = z.object({
  prompt: z.string().min(1),
  weight: z.number().min(-100).max(100),
})

export type LlmCriterion = z.infer<typeof LlmCriterionSchema>

export const RubricSchema = z.object({
  criteria: z.array(RubricCriterionSchema),
  llmCriteria: z.array(LlmCriterionSchema).optional(),
  /** Minimum total score for a lead to qualify. */
  threshold: z.number(),
})

export type Rubric = z.infer<typeof RubricSchema>

/** Per-criterion breakdown, so a score is always explainable. */
export const ScoreBreakdownEntrySchema = z.object({
  label: z.string(),
  signal: z.string(),
  /** null when the signal was never computed (provider skipped or errored). */
  actualValue: z.unknown().nullable(),
  matched: z.boolean(),
  weight: z.number(),
  /** Contribution to the total: weight when matched, 0 otherwise. */
  points: z.number(),
  hard: z.boolean(),
  /** Set when a hard criterion failed and excluded the lead. */
  excluded: z.boolean().default(false),
})

export type ScoreBreakdownEntry = z.infer<typeof ScoreBreakdownEntrySchema>

export const LlmAssessmentSchema = z.object({
  score: z.number(),
  reasoning: z.string(),
  best_angle: z.string(),
  risk: z.string(),
})

export type LlmAssessment = z.infer<typeof LlmAssessmentSchema>

export const LeadScoreSchema = z.object({
  total: z.number(),
  qualified: z.boolean(),
  threshold: z.number(),
  breakdown: z.array(ScoreBreakdownEntrySchema),
  llm: LlmAssessmentSchema.nullable().optional(),
})

export type LeadScore = z.infer<typeof LeadScoreSchema>
