import Anthropic from "@anthropic-ai/sdk"

/**
 * The narrow slice of the Anthropic API that the scoring layer needs.
 *
 * Declared as an interface rather than used directly so tests can supply
 * recorded answers: no test in this repository is allowed to make a live API
 * call, and the LLM stage has to be exercisable without a key.
 */
export interface LlmClient {
  /**
   * Asks the model to fill a JSON schema and returns the parsed object.
   *
   * Implementations must reject rather than return a partial object - a caller
   * that gets an object back is entitled to assume it validated.
   */
  completeJson(request: LlmJsonRequest): Promise<LlmJsonResponse>
}

export interface LlmJsonRequest {
  /** "fast" for per-lead work, "smart" for one-off authoring tasks. */
  tier: "fast" | "smart"
  system: string
  prompt: string
  /** JSON Schema the answer must satisfy. Enforced by the API, not by us. */
  schema: Record<string, unknown>
  maxTokens?: number
  signal?: AbortSignal
}

export interface LlmJsonResponse {
  value: unknown
  usage: { inputTokens: number; outputTokens: number }
}

export interface AnthropicClientOptions {
  apiKey: string
  /** Per-lead classification. Cheap, because it runs once per company. */
  fastModel: string
  /** Authoring and calibration. Runs once per user action, so it can cost more. */
  smartModel: string
  /** Injectable for tests; defaults to the real SDK. */
  sdk?: Pick<Anthropic, "messages">
}

/**
 * Raised when the model answered but the answer was unusable.
 *
 * Kept distinct from transport errors: a malformed answer is a data problem for
 * this one lead, while a 401 means the whole run should stop.
 */
export class LlmResponseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LlmResponseError"
  }
}

/**
 * Thrown when the LLM stage is reached without a configured key.
 *
 * The API layer turns this into a 503 with a stable problem slug rather than a
 * 500: the deployment is incomplete, not broken.
 */
export class LlmNotConfiguredError extends Error {
  constructor() {
    super("ANTHROPIC_API_KEY is not configured")
    this.name = "LlmNotConfiguredError"
  }
}

const TOOL_NAME = "record_assessment"

export function createAnthropicClient(options: AnthropicClientOptions): LlmClient {
  const sdk = options.sdk ?? new Anthropic({ apiKey: options.apiKey })

  return {
    async completeJson(request: LlmJsonRequest): Promise<LlmJsonResponse> {
      const model = request.tier === "fast" ? options.fastModel : options.smartModel

      // Tool use rather than free-text JSON: the API validates the shape against
      // the schema, so a truncated or chatty answer fails here instead of
      // surfacing as a plausible-looking wrong score three layers up.
      const message = await sdk.messages.create(
        {
          model,
          max_tokens: request.maxTokens ?? 1024,
          system: request.system,
          tools: [
            {
              name: TOOL_NAME,
              description: "Records the assessment. Call this exactly once.",
              input_schema: request.schema as Anthropic.Tool["input_schema"],
            },
          ],
          tool_choice: { type: "tool", name: TOOL_NAME },
          messages: [{ role: "user", content: request.prompt }],
        },
        request.signal ? { signal: request.signal } : undefined
      )

      const block = message.content.find((entry) => entry.type === "tool_use")
      if (!block || block.type !== "tool_use") {
        throw new LlmResponseError(
          `model returned no tool call (stop_reason: ${message.stop_reason ?? "unknown"})`
        )
      }

      return {
        value: block.input,
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
        },
      }
    },
  }
}

/**
 * Builds the client from environment configuration, or returns null.
 *
 * null rather than throwing: without a key the rubric simply skips its LLM stage
 * and scores on rules alone. A search that returns rule-scored leads is far more
 * useful than one that fails because an optional stage is unconfigured.
 */
export function createLlmClientFromEnv(env: {
  ANTHROPIC_API_KEY?: string | undefined
  ANTHROPIC_MODEL_FAST: string
  ANTHROPIC_MODEL_SMART: string
}): LlmClient | null {
  if (!env.ANTHROPIC_API_KEY) return null

  return createAnthropicClient({
    apiKey: env.ANTHROPIC_API_KEY,
    fastModel: env.ANTHROPIC_MODEL_FAST,
    smartModel: env.ANTHROPIC_MODEL_SMART,
  })
}
