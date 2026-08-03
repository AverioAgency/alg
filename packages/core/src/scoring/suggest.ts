import { OperatorSchema, RubricSchema, type Rubric, type SignalDef } from "@alg/shared"
import { LlmResponseError, type LlmClient } from "./llm-client.js"

/**
 * Turns a free-text description of a target customer into a draft rubric.
 *
 * The output is a draft, not a decision: it comes back to the user for editing
 * before anything is saved. That framing matters for the prompt - the model is
 * asked to be explicit about what it could not express, rather than to quietly
 * approximate an unmeasurable wish with a measurable proxy.
 */

export interface SuggestRubricOptions {
  client: LlmClient
  /** What the user typed, e.g. "Handwerksbetriebe in OÖ ohne moderne Website". */
  description: string
  /** Everything a provider can actually produce for this target type. */
  catalog: readonly SignalDef[]
  signal?: AbortSignal
}

export interface SuggestRubricResult {
  rubric: Rubric
  /** Aspects of the description no available signal can express. */
  notCovered: string[]
  rationale: string
  usage: { inputTokens: number; outputTokens: number }
}

const SYSTEM_PROMPT = [
  "Du entwirfst Bewertungsrubriken für die Lead-Qualifizierung.",
  "",
  "Der Nutzer beschreibt seinen Wunschkunden in Freitext. Du übersetzt das in",
  "gewichtete Kriterien auf messbaren Signalen.",
  "",
  "Harte Regeln:",
  "- Verwende ausschließlich Signal-Keys aus der übergebenen Liste. Ein erfundener",
  "  Key macht die Rubrik unbrauchbar.",
  "- Nutze nur Operatoren, die beim jeweiligen Signal erlaubt sind.",
  "- Was sich mit den verfügbaren Signalen nicht ausdrücken lässt, gehört nach",
  "  not_covered - nicht in ein ungefähr passendes Kriterium. Ein ehrliches",
  "  'das kann ich nicht messen' ist für den Nutzer wertvoller als ein Proxy,",
  "  den er für eine Messung hält.",
  "- hard=true nur für echte Ausschlusskriterien. Ein hartes Kriterium wirft den",
  "  Lead komplett raus, auch wenn er sonst perfekt passt.",
  "- Negative Gewichte für Eigenschaften, die gegen den Lead sprechen.",
  "- Setze die Schwelle so, dass ein durchschnittlicher Treffer knapp darunter und",
  "  ein guter deutlich darüber liegt.",
  "- Labels auf Deutsch, kurz und für den Nutzer verständlich.",
].join("\n")

function buildSchema(catalog: readonly SignalDef[]): Record<string, unknown> {
  const keys = catalog.map((def) => def.key)

  return {
    type: "object",
    properties: {
      criteria: {
        type: "array",
        minItems: 1,
        maxItems: 12,
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "Kurzes deutsches Label." },
            // enum rather than a plain string: the API rejects an invented key
            // before it ever reaches us.
            signal: { type: "string", enum: keys },
            op: {
              type: "string",
              enum: ["eq", "neq", "gt", "gte", "lt", "lte", "in", "nin", "contains", "exists"],
            },
            value: {
              description: "Vergleichswert. Bei exists true, bei in/nin ein Array.",
            },
            weight: { type: "integer", minimum: -100, maximum: 100 },
            hard: { type: "boolean" },
          },
          required: ["label", "signal", "op", "value", "weight", "hard"],
          additionalProperties: false,
        },
      },
      llm_prompt: {
        type: ["string", "null"],
        description:
          "Optionale Anweisung für eine LLM-Bewertungsstufe auf Deutsch, falls die Beschreibung eine Einschätzung verlangt, die keine Regel abbildet. Sonst null.",
      },
      llm_weight: {
        type: ["integer", "null"],
        minimum: 0,
        maximum: 100,
        description: "Gewicht der LLM-Stufe. null, wenn llm_prompt null ist.",
      },
      threshold: { type: "integer", minimum: 0, maximum: 100 },
      not_covered: {
        type: "array",
        items: { type: "string" },
        description:
          "Wünsche aus der Beschreibung, für die es kein passendes Signal gibt. Auf Deutsch, konkret.",
      },
      rationale: {
        type: "string",
        description: "Zwei bis drei Sätze auf Deutsch: warum diese Gewichtung.",
      },
    },
    required: ["criteria", "threshold", "not_covered", "rationale"],
    additionalProperties: false,
  }
}

export async function suggestRubric(options: SuggestRubricOptions): Promise<SuggestRubricResult> {
  if (options.catalog.length === 0) {
    throw new LlmResponseError("no signals available for this target type")
  }

  const response = await options.client.completeJson({
    // The smart model: this runs once per user action, and a bad rubric costs
    // far more than the token difference.
    tier: "smart",
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(options.description, options.catalog),
    schema: buildSchema(options.catalog),
    maxTokens: 4096,
    ...(options.signal ? { signal: options.signal } : {}),
  })

  return parseSuggestion(response.value, options.catalog, response.usage)
}

/** Exported for tests: the mapping is where a wrong operator would slip through. */
export function parseSuggestion(
  value: unknown,
  catalog: readonly SignalDef[],
  usage: { inputTokens: number; outputTokens: number }
): SuggestRubricResult {
  if (typeof value !== "object" || value === null) {
    throw new LlmResponseError("suggestion was not an object")
  }

  const raw = asRecord(value)
  const rawCriteria = Array.isArray(raw.criteria) ? raw.criteria : []
  const byKey = new Map(catalog.map((def) => [def.key, def]))

  const criteria = rawCriteria.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return []
    const item = asRecord(entry)
    const def = byKey.get(String(item.signal))
    if (!def) return []

    // Parsed through the shared enum rather than cast: the schema constrains the
    // signal key but not that the operator suits that key's type, and "gt" on a
    // boolean yields a criterion that can never match - which reads to the user
    // as a broken score rather than a bad suggestion.
    const op = OperatorSchema.safeParse(item.op)
    if (!op.success || !def.operators.includes(op.data)) return []

    return [
      {
        label: String(item.label),
        signal: def.key,
        condition: { op: op.data, value: item.value },
        weight: Number(item.weight),
        hard: item.hard === true,
      },
    ]
  })

  const llmPrompt = typeof raw.llm_prompt === "string" ? raw.llm_prompt.trim() : ""
  const llmWeight = typeof raw.llm_weight === "number" ? raw.llm_weight : 0

  const candidate = {
    criteria,
    ...(llmPrompt !== "" && llmWeight > 0
      ? { llmCriteria: [{ prompt: llmPrompt, weight: llmWeight }] }
      : {}),
    threshold: typeof raw.threshold === "number" ? raw.threshold : 50,
  }

  const parsed = RubricSchema.safeParse(candidate)
  if (!parsed.success) {
    throw new LlmResponseError(`suggested rubric is invalid: ${parsed.error.message}`)
  }
  if (parsed.data.criteria.length === 0) {
    throw new LlmResponseError("suggestion contained no usable criteria")
  }

  return {
    rubric: parsed.data,
    notCovered: Array.isArray(raw.not_covered) ? raw.not_covered.map(String) : [],
    rationale: typeof raw.rationale === "string" ? raw.rationale : "",
    usage,
  }
}

/** Index signature access without a cast; unknown keys read as undefined. */
function asRecord(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value))
}

function buildPrompt(description: string, catalog: readonly SignalDef[]): string {
  const lines = ["<verfuegbare_signale>"]

  for (const def of catalog) {
    const parts = [`${def.key} (${def.type})`, `Operatoren: ${def.operators.join(", ")}`]
    if (def.enumValues?.length) parts.push(`Werte: ${def.enumValues.join(", ")}`)
    if (def.unit) parts.push(`Einheit: ${def.unit}`)
    lines.push(`- ${parts.join(" | ")}`)
  }

  lines.push(
    "</verfuegbare_signale>",
    "",
    "<beschreibung>",
    description,
    "</beschreibung>",
    "",
    "Entwirf die Rubrik."
  )
  return lines.join("\n")
}
