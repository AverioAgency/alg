import { describe, expect, it } from "vitest"
import { type SignalDef } from "@alg/shared"
import { LlmResponseError, type LlmClient, type LlmJsonRequest } from "../llm-client.js"
import { relevantSignals, runLlmStage } from "../llm-stage.js"
import { parseSuggestion, suggestRubric } from "../suggest.js"
import { ERP_REPLACEMENT_RUBRIC, WEBSITE_SALES_RUBRIC } from "../fixtures.js"
import { evaluateRubric } from "../evaluate.js"

/**
 * The LLM stage against recorded answers.
 *
 * No test here reaches the network. What is being tested is the code around the
 * model - narrowing, validation, and the behaviour when the model returns
 * something unusable - because that is where a real run goes wrong, not in the
 * model call itself.
 */

/** Walks a nested object by key, returning undefined rather than throwing. */
function pick(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined
    current = Reflect.get(current, key)
  }
  return current
}

/** Returns the same recorded answer for every call and records the request. */
function recordedClient(value: unknown): LlmClient & { calls: LlmJsonRequest[] } {
  const calls: LlmJsonRequest[] = []
  return {
    calls,
    async completeJson(request) {
      calls.push(request)
      return { value, usage: { inputTokens: 820, outputTokens: 140 } }
    },
  }
}

const RECORDED_ASSESSMENT = {
  score: 72,
  reasoning:
    "Die Website läuft auf TYPO3 und ist nicht mobiloptimiert, was auf einen länger nicht angefassten Digitalstack hindeutet. Impressum und Geschäftsführung sind sauber gepflegt, das Unternehmen ist also greifbar.",
  best_angle:
    "Über die fehlende Mobiloptimierung einsteigen - das ist für den Betrieb sofort sichtbar.",
  risk: "Ohne Shop-System fehlt ein Hinweis darauf, dass überhaupt Budget für IT da ist.",
}

const SIGNALS = {
  "web.presence.has_website": true,
  "web.presence.reachable": true,
  "web.techstack.cms": "TYPO3",
  "web.features.mobile_ready": false,
  "legal.impressum.managing_directors": ["Anna Huber"],
  "contact.basic.reachable": true,
  // Not referenced by the ERP rubric - the narrowing has to drop it.
  "web.features.structured_data": true,
  "some.unreferenced.signal": "irrelevant",
}

const ENTITY = { name: "Muster GmbH", city: "Wels", domain: "muster.at" }

describe("runLlmStage", () => {
  it("returns null when the rubric has no LLM criteria", async () => {
    // The caller must not have to know whether a rubric uses the stage.
    const client = recordedClient(RECORDED_ASSESSMENT)
    const result = await runLlmStage({
      client,
      rubric: WEBSITE_SALES_RUBRIC,
      signals: SIGNALS,
      entity: ENTITY,
    })

    expect(result).toBeNull()
    expect(client.calls).toHaveLength(0)
  })

  it("returns a validated assessment", async () => {
    const client = recordedClient(RECORDED_ASSESSMENT)
    const result = await runLlmStage({
      client,
      rubric: ERP_REPLACEMENT_RUBRIC,
      signals: SIGNALS,
      entity: ENTITY,
    })

    expect(result?.assessment.score).toBe(72)
    expect(result?.assessment.best_angle).toContain("Mobiloptimierung")
    expect(result?.usage.outputTokens).toBe(140)
  })

  it("uses the fast tier - this runs once per company", async () => {
    const client = recordedClient(RECORDED_ASSESSMENT)
    await runLlmStage({
      client,
      rubric: ERP_REPLACEMENT_RUBRIC,
      signals: SIGNALS,
      entity: ENTITY,
    })

    expect(client.calls[0]?.tier).toBe("fast")
  })

  it("sends only the signals the rubric references", async () => {
    // Both a cost and a correctness property: a signal the user left out of the
    // rubric must not influence the verdict through the prompt.
    const client = recordedClient(RECORDED_ASSESSMENT)
    await runLlmStage({
      client,
      rubric: ERP_REPLACEMENT_RUBRIC,
      signals: SIGNALS,
      entity: ENTITY,
    })

    const prompt = client.calls[0]?.prompt ?? ""
    expect(prompt).toContain("web.techstack.cms")
    expect(prompt).not.toContain("some.unreferenced.signal")
  })

  it("states plainly when no signals were collected", async () => {
    // An empty section invites the model to fill the gap from priors, which is
    // exactly wrong after a failed crawl.
    const client = recordedClient(RECORDED_ASSESSMENT)
    await runLlmStage({
      client,
      rubric: ERP_REPLACEMENT_RUBRIC,
      signals: {},
      entity: ENTITY,
    })

    expect(client.calls[0]?.prompt).toContain("Keine Signale erhoben")
  })

  it("renders booleans in German rather than as true/false", async () => {
    const client = recordedClient(RECORDED_ASSESSMENT)
    await runLlmStage({
      client,
      rubric: ERP_REPLACEMENT_RUBRIC,
      signals: SIGNALS,
      entity: ENTITY,
    })

    expect(client.calls[0]?.prompt).toContain("web.features.mobile_ready: nein")
  })

  it("rejects an answer that does not match the contract", async () => {
    // The API enforces the schema, but a client-side parse means the scorer only
    // ever sees a value the frontend can also type against.
    const client = recordedClient({ score: 72, reasoning: "..." })

    await expect(
      runLlmStage({
        client,
        rubric: ERP_REPLACEMENT_RUBRIC,
        signals: SIGNALS,
        entity: ENTITY,
      })
    ).rejects.toBeInstanceOf(LlmResponseError)
  })

  it("passes the abort signal through", async () => {
    const client = recordedClient(RECORDED_ASSESSMENT)
    const controller = new AbortController()

    await runLlmStage({
      client,
      rubric: ERP_REPLACEMENT_RUBRIC,
      signals: SIGNALS,
      entity: ENTITY,
      signal: controller.signal,
    })

    expect(client.calls[0]?.signal).toBe(controller.signal)
  })
})

describe("relevantSignals", () => {
  it("keeps referenced keys and drops the rest", () => {
    const narrowed = relevantSignals(ERP_REPLACEMENT_RUBRIC, SIGNALS)

    expect(narrowed).toHaveProperty("web.techstack.cms")
    expect(narrowed).not.toHaveProperty("some.unreferenced.signal")
  })

  it("omits referenced keys that were never measured", () => {
    // Absent must stay absent rather than becoming an explicit null, so the
    // model is not told "we looked and found nothing" when nobody looked.
    const narrowed = relevantSignals(ERP_REPLACEMENT_RUBRIC, {
      "web.techstack.cms": "TYPO3",
    })

    expect(Object.keys(narrowed)).toEqual(["web.techstack.cms"])
  })
})

describe("the LLM stage feeding into the score", () => {
  it("moves the total without replacing the rule score", async () => {
    const client = recordedClient(RECORDED_ASSESSMENT)
    const stage = await runLlmStage({
      client,
      rubric: ERP_REPLACEMENT_RUBRIC,
      signals: SIGNALS,
      entity: ENTITY,
    })

    const withoutLlm = evaluateRubric({ signals: SIGNALS, rubric: ERP_REPLACEMENT_RUBRIC })
    const withLlm = evaluateRubric({
      signals: SIGNALS,
      rubric: ERP_REPLACEMENT_RUBRIC,
      llm: stage?.assessment ?? null,
    })

    expect(withLlm.total).not.toBe(withoutLlm.total)
    expect(withLlm.llm?.score).toBe(72)
    // The rule breakdown is untouched by the LLM stage - it is an addition, not
    // an override.
    expect(withLlm.breakdown).toEqual(withoutLlm.breakdown)
  })

  it("scores on rules alone when the stage did not run", () => {
    // The no-key path: llm is null and the score is still usable.
    const score = evaluateRubric({ signals: SIGNALS, rubric: ERP_REPLACEMENT_RUBRIC })

    expect(score.llm).toBeNull()
    expect(score.total).toBeGreaterThan(0)
    expect(score.breakdown.length).toBe(ERP_REPLACEMENT_RUBRIC.criteria.length)
  })
})

// --- Rubric suggestion -------------------------------------------------------

const CATALOG: SignalDef[] = [
  {
    key: "web.presence.has_website",
    type: "boolean",
    operators: ["eq", "exists"],
    labelKey: "signal.web.presence.has_website",
  },
  {
    key: "web.techstack.cms",
    type: "string",
    operators: ["eq", "in", "exists"],
    labelKey: "signal.web.techstack.cms",
    enumValues: ["TYPO3", "WordPress", "Joomla"],
  },
  {
    key: "web.features.mobile_ready",
    type: "boolean",
    operators: ["eq", "exists"],
    labelKey: "signal.web.features.mobile_ready",
  },
]

const RECORDED_SUGGESTION = {
  criteria: [
    {
      label: "Keine Website vorhanden",
      signal: "web.presence.has_website",
      op: "eq",
      value: false,
      weight: 45,
      hard: false,
    },
    {
      label: "Nicht mobiloptimiert",
      signal: "web.features.mobile_ready",
      op: "eq",
      value: false,
      weight: 30,
      hard: false,
    },
  ],
  llm_prompt: null,
  llm_weight: null,
  threshold: 40,
  not_covered: ["Mitarbeiterzahl unter 20 - dazu liegt kein Signal vor."],
  rationale: "Fehlende und veraltete Websites sind die stärksten Kaufsignale.",
}

const USAGE = { inputTokens: 1200, outputTokens: 400 }

describe("suggestRubric", () => {
  it("produces a rubric the scorer can run", async () => {
    const client = recordedClient(RECORDED_SUGGESTION)
    const result = await suggestRubric({
      client,
      description: "Handwerksbetriebe ohne moderne Website",
      catalog: CATALOG,
    })

    expect(result.rubric.criteria).toHaveLength(2)
    expect(result.rubric.threshold).toBe(40)

    const score = evaluateRubric({
      signals: { "web.presence.has_website": false, "web.features.mobile_ready": false },
      rubric: result.rubric,
    })
    expect(score.total).toBe(100)
  })

  it("uses the smart tier - a bad rubric costs more than the tokens", async () => {
    const client = recordedClient(RECORDED_SUGGESTION)
    await suggestRubric({
      client,
      description: "Handwerksbetriebe",
      catalog: CATALOG,
    })

    expect(client.calls[0]?.tier).toBe("smart")
  })

  it("carries through what it could not express", async () => {
    // The honest answer is more useful than a proxy the user mistakes for a
    // measurement.
    const client = recordedClient(RECORDED_SUGGESTION)
    const result = await suggestRubric({
      client,
      description: "Handwerksbetriebe unter 20 Mitarbeitern",
      catalog: CATALOG,
    })

    expect(result.notCovered).toHaveLength(1)
    expect(result.notCovered[0]).toContain("Mitarbeiterzahl")
  })

  it("constrains the model to signals that actually exist", async () => {
    const client = recordedClient(RECORDED_SUGGESTION)
    await suggestRubric({ client, description: "...", catalog: CATALOG })

    // Walked with plain property access rather than a cast chain: the shape is
    // ours, and a wrong path should fail the test rather than be asserted away.
    const enumValues = pick(client.calls[0]?.schema, [
      "properties",
      "criteria",
      "items",
      "properties",
      "signal",
      "enum",
    ])

    expect(enumValues).toEqual([
      "web.presence.has_website",
      "web.techstack.cms",
      "web.features.mobile_ready",
    ])
  })

  it("lists the allowed operators per signal in the prompt", async () => {
    const client = recordedClient(RECORDED_SUGGESTION)
    await suggestRubric({ client, description: "...", catalog: CATALOG })

    expect(client.calls[0]?.prompt).toContain("web.techstack.cms (string)")
    expect(client.calls[0]?.prompt).toContain("Werte: TYPO3, WordPress, Joomla")
  })

  it("refuses when no signals are available at all", async () => {
    const client = recordedClient(RECORDED_SUGGESTION)

    await expect(suggestRubric({ client, description: "...", catalog: [] })).rejects.toBeInstanceOf(
      LlmResponseError
    )
  })
})

describe("parseSuggestion", () => {
  it("drops a criterion whose operator is not allowed for that signal", () => {
    // "gt" on a boolean produces a criterion that can never match, which reads
    // to the user as a broken score rather than a bad suggestion.
    const result = parseSuggestion(
      {
        ...RECORDED_SUGGESTION,
        criteria: [
          ...RECORDED_SUGGESTION.criteria,
          {
            label: "Unsinn",
            signal: "web.presence.has_website",
            op: "gt",
            value: 3,
            weight: 20,
            hard: false,
          },
        ],
      },
      CATALOG,
      USAGE
    )

    expect(result.rubric.criteria).toHaveLength(2)
    expect(result.rubric.criteria.map((c) => c.label)).not.toContain("Unsinn")
  })

  it("drops a criterion on a signal no provider produces", () => {
    const result = parseSuggestion(
      {
        ...RECORDED_SUGGESTION,
        criteria: [
          ...RECORDED_SUGGESTION.criteria,
          {
            label: "Erfunden",
            signal: "hiring.jobs.mentions_sap",
            op: "eq",
            value: true,
            weight: 40,
            hard: false,
          },
        ],
      },
      CATALOG,
      USAGE
    )

    expect(result.rubric.criteria).toHaveLength(2)
  })

  it("adds the LLM stage only when prompt and weight are both present", () => {
    const withStage = parseSuggestion(
      { ...RECORDED_SUGGESTION, llm_prompt: "Beurteile die Digitalreife.", llm_weight: 20 },
      CATALOG,
      USAGE
    )
    expect(withStage.rubric.llmCriteria).toHaveLength(1)

    const weightless = parseSuggestion(
      { ...RECORDED_SUGGESTION, llm_prompt: "Beurteile die Digitalreife.", llm_weight: 0 },
      CATALOG,
      USAGE
    )
    expect(weightless.rubric.llmCriteria).toBeUndefined()
  })

  it("fails rather than returning an empty rubric", () => {
    // An empty rubric scores every lead at zero, which looks like the engine is
    // broken. Failing loudly is the honest outcome.
    expect(() => parseSuggestion({ ...RECORDED_SUGGESTION, criteria: [] }, CATALOG, USAGE)).toThrow(
      LlmResponseError
    )
  })

  it("fails on a non-object answer", () => {
    expect(() => parseSuggestion("nope", CATALOG, USAGE)).toThrow(LlmResponseError)
  })
})
