import { LlmAssessmentSchema, type LlmAssessment, type Rubric } from "@alg/shared"
import { LlmResponseError, type LlmClient, type LlmJsonRequest } from "./llm-client.js"

/**
 * The optional LLM stage of a rubric.
 *
 * Rules answer "does this lead match what the user described". This stage
 * answers the part a rule cannot: whether the picture the signals paint actually
 * fits the pitch. It contributes on the same 0..100 scale as the rules and is
 * weighted by the rubric, so a user who does not trust it can weight it to zero
 * without touching code.
 */

/** Enforced by the API, so a malformed answer never reaches the scorer. */
const ASSESSMENT_SCHEMA = {
  type: "object",
  properties: {
    score: {
      type: "integer",
      minimum: 0,
      maximum: 100,
      description:
        "0 = does not fit the described target at all, 100 = ideal fit. Judge only from the signals given.",
    },
    reasoning: {
      type: "string",
      description:
        "Two or three sentences in German explaining the score, citing concrete signals.",
    },
    best_angle: {
      type: "string",
      description: "In German: the most promising opening for an approach to this company.",
    },
    risk: {
      type: "string",
      description:
        "In German: the strongest reason this lead might be a waste of time. Never leave empty - if there is no risk, say so explicitly.",
    },
    disqualified: {
      type: "boolean",
      description:
        "true only when the company plainly is not what was searched for - wrong industry, wrong kind of business. Not for a merely weak lead: that is what a low score is for.",
    },
  },
  required: ["score", "reasoning", "best_angle", "risk", "disqualified"],
  additionalProperties: false,
} as const

const SYSTEM_PROMPT = [
  "Du bewertest Verkaufs-Leads für einen B2B-Vertrieb im deutschsprachigen Raum.",
  "",
  "Du bekommst die Beschreibung eines Zielkunden und die erhobenen Fakten zu einem",
  "Unternehmen. Bewerte ausschließlich anhand dieser Fakten.",
  "",
  "Regeln:",
  "- Erfinde keine Fakten. Was nicht dasteht, weißt du nicht.",
  "- Ein fehlendes Signal ist kein negatives Signal. Wenn zu wenig bekannt ist, um",
  "  zu urteilen, vergib einen mittleren Wert und schreibe das in die Begründung.",
  "- Begründe mit konkreten Signalen, nicht mit Branchenklischees.",
  "- disqualified=true nur, wenn das Unternehmen erkennbar nicht das ist, wonach",
  "  gesucht wurde - falsche Branche, falsche Art von Betrieb. Ein Restaurant in",
  "  einer Suche nach Elektrotechnik gehört nicht in die Liste, egal wie gut",
  "  seine Website ist. Für einen bloß schwachen Lead gibt es die Punktzahl.",
  "- Antworte auf Deutsch.",
].join("\n")

export interface LlmStageOptions {
  client: LlmClient
  rubric: Rubric
  /** Flat signal map for one company, as the enrichment layer stores it. */
  signals: Record<string, unknown>
  /** Shown to the model for context; never invented from. */
  entity: { name: string; city?: string | null; domain?: string | null }
  signal?: AbortSignal
}

export interface LlmStageResult {
  assessment: LlmAssessment
  usage: { inputTokens: number; outputTokens: number }
}

/**
 * Runs the LLM stage for one company.
 *
 * Returns null when the rubric has no LLM criteria - the caller does not need to
 * know whether a rubric uses the stage, it just passes the result through.
 */
export async function runLlmStage(options: LlmStageOptions): Promise<LlmStageResult | null> {
  const criteria = options.rubric.llmCriteria ?? []
  if (criteria.length === 0) return null

  const relevant = relevantSignals(options.rubric, options.signals)

  const request: LlmJsonRequest = {
    tier: "fast",
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(
      criteria.map((c) => c.prompt),
      options.entity,
      relevant
    ),
    // ASSESSMENT_SCHEMA is `as const` so its literal types stay readable above;
    // the request type wants a plain JSON Schema object. This widens a frozen
    // literal, nothing more.
    // eslint-disable-next-line no-restricted-syntax
    schema: ASSESSMENT_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 1024,
    ...(options.signal ? { signal: options.signal } : {}),
  }

  const response = await options.client.completeJson(request)

  // Belt and braces: the API enforces the schema, but a Zod parse here means the
  // scorer only ever sees a value that matches the shared contract - the same
  // one the frontend types against.
  const parsed = LlmAssessmentSchema.safeParse(response.value)
  if (!parsed.success) {
    throw new LlmResponseError(`assessment did not match the schema: ${parsed.error.message}`)
  }

  return { assessment: parsed.data, usage: response.usage }
}

/**
 * Narrows the signal map to what the rubric actually references.
 *
 * Two reasons. Cost: sending every signal for every lead multiplies the token
 * bill by data nobody asked about. Correctness: a signal the user deliberately
 * left out of the rubric must not sway the verdict through the back door.
 */
export function relevantSignals(
  rubric: Rubric,
  signals: Record<string, unknown>
): Record<string, unknown> {
  const keys = new Set(rubric.criteria.map((criterion) => criterion.signal))
  const out: Record<string, unknown> = {}

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(signals, key)) {
      out[key] = signals[key]
    }
  }
  return out
}

function buildPrompt(
  prompts: readonly string[],
  entity: LlmStageOptions["entity"],
  signals: Record<string, unknown>
): string {
  const lines: string[] = ["<zielkunde>", ...prompts, "</zielkunde>", "", "<unternehmen>"]

  lines.push(`Name: ${entity.name}`)
  if (entity.city) lines.push(`Ort: ${entity.city}`)
  if (entity.domain) lines.push(`Domain: ${entity.domain}`)
  lines.push("</unternehmen>", "", "<signale>")

  const entries = Object.entries(signals)
  if (entries.length === 0) {
    // Said out loud rather than left as an empty block: an empty section invites
    // the model to fill the gap from priors, which is exactly what must not
    // happen when a crawl failed.
    lines.push("Keine Signale erhoben. Es liegen keine Fakten zu diesem Unternehmen vor.")
  } else {
    for (const [key, value] of entries) {
      lines.push(`${key}: ${formatValue(value)}`)
    }
  }

  lines.push("</signale>", "", "Bewerte dieses Unternehmen und rufe record_assessment auf.")
  return lines.join("\n")
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "unbekannt"
  if (typeof value === "boolean") return value ? "ja" : "nein"
  if (Array.isArray(value)) return value.length === 0 ? "keine" : value.map(String).join(", ")
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}
