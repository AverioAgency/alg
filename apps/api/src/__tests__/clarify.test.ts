import { describe, expect, it } from "vitest"
import { buildSignalRegistry } from "@alg/adapters-signals"
import { MAX_QUESTIONS, PLAYBOOKS } from "@alg/core"
import { decodeSearchSpec } from "@alg/shared"
import { createClarifyRouter } from "../routes/clarify.js"
import { createFakeDb, type FakeState } from "./helpers/fake-db.js"

/**
 * The clarification endpoints, exercised through the real handlers.
 *
 * The flow is stateless: the client sends the description and answers, the
 * server computes questions and spec. What is worth testing is that the
 * computation is honest - the preview must show the cost before anything runs,
 * and a default must never quietly narrow the search.
 */

interface JsonResponse {
  body: unknown
  status: number
}

async function callRoute(
  method: "get" | "post" | "patch" | "delete",
  path: string,
  payload: { body?: unknown; params?: Record<string, string>; seed?: Partial<FakeState> } = {}
): Promise<JsonResponse> {
  const registry = buildSignalRegistry({ userAgent: "AlgBot/1.0" })
  // The clarify and preview routes read the workspace's onboarding profile, so
  // a workspace row has to exist even when the test is about neither.
  const { db } = createFakeDb(
    payload.seed ?? {
      workspaces: [{ id: "11111111-1111-1111-1111-111111111111", slug: "test" }],
    }
  )
  const router = createClarifyRouter({ db, registry })

  const layer = router.stack.find(
    (entry) => entry.route?.path === path && entry.route.methods[method] === true
  )
  if (!layer?.route) throw new Error(`Route ${method.toUpperCase()} ${path} is not registered`)

  const handler = layer.route.stack[0]?.handle
  if (!handler) throw new Error(`Route ${path} has no handler`)

  return await new Promise<JsonResponse>((resolve, reject) => {
    const res = {
      statusCode: 200,
      json(body: unknown) {
        resolve({ body, status: this.statusCode })
        return this
      },
      status(code: number) {
        this.statusCode = code
        return this
      },
      end() {
        resolve({ body: null, status: this.statusCode })
        return this
      },
    }

    const req = {
      body: payload.body ?? {},
      params: payload.params ?? {},
      query: {},
      ctx: { workspaceId: "11111111-1111-1111-1111-111111111111", userId: "u1" },
    }

    void handler(req as never, res as never, (error?: unknown) => {
      reject(error instanceof Error ? error : new Error(String(error)))
    })
  })
}

interface ClarifyBody {
  questions: { id: string; type: string; prompt_key: string; default_value: unknown }[]
  spec: { targetType: string; filters: unknown; limit?: number }
  runnable: boolean
  skippable: boolean
}

interface PreviewBody {
  spec: { limit?: number; filters: unknown }
  runnable: boolean
  share_query: string
  unanswered: string[]
  plan: { providers: { provider_id: string }[]; empty: boolean }
  cost: { entities: number; total_eur: number; per_entity_eur: number }
}

async function clarify(body: unknown): Promise<ClarifyBody> {
  const { body: result } = await callRoute("post", "/searches/clarify", { body })
  return result as ClarifyBody
}

async function preview(body: unknown): Promise<PreviewBody> {
  const { body: result } = await callRoute("post", "/searches/preview", { body })
  return result as PreviewBody
}

describe("POST /v1/searches/clarify", () => {
  it("asks at most four questions", async () => {
    const result = await clarify({ description: "Handwerksbetriebe", target_type: "company" })
    expect(result.questions.length).toBeLessThanOrEqual(MAX_QUESTIONS)
  })

  it("reports a bare description as not yet runnable", async () => {
    // No geographic constraint: Overpass refuses outright without one.
    const result = await clarify({ description: "Firmen", target_type: "company" })
    expect(result.runnable).toBe(false)
  })

  it("becomes runnable once the region is answered", async () => {
    const result = await clarify({
      description: "Firmen",
      target_type: "company",
      answers: [{ question_id: "region", value: "oberoesterreich" }],
    })

    expect(result.runnable).toBe(true)
    expect(result.questions.map((q) => q.id)).not.toContain("region")
  })

  it("returns i18n keys, never German strings", async () => {
    const result = await clarify({ description: "Firmen", target_type: "company" })
    expect(result.questions.every((q) => q.prompt_key.startsWith("clarify."))).toBe(true)
  })

  it("says the wizard can be skipped when every remaining question has a default", async () => {
    // skippable is false while the category question is open, because guessing
    // an industry would narrow the search to something nobody asked for.
    const withCategory = await clarify({
      description: "Firmen",
      target_type: "company",
      answers: [{ question_id: "category", value: ["industrial"] }],
    })

    expect(withCategory.skippable).toBe(true)
  })

  it("ignores an answer to a question it does not know", async () => {
    // The frontend may be a version ahead; dropping the answer beats a 400.
    const result = await clarify({
      description: "Firmen",
      target_type: "company",
      answers: [{ question_id: "favourite_colour", value: "blau" }],
    })

    expect(result.runnable).toBe(false)
  })
})

describe("POST /v1/searches/preview", () => {
  it("costs nothing when no signal is referenced", async () => {
    // The M2 acceptance property, visible at the API: a search that mentions no
    // signal produces an empty plan and is free. This is what keeps a market
    // research run from paying for website crawls nobody looks at.
    const result = await preview({
      description: "Alle Firmen in OÖ",
      target_type: "company",
      answers: [
        { question_id: "region", value: "oberoesterreich" },
        { question_id: "category", value: ["industrial"] },
      ],
    })

    expect(result.plan.empty).toBe(true)
    expect(result.plan.providers).toStrictEqual([])
    expect(result.cost.total_eur).toBe(0)
  })

  it("plans providers as soon as a signal is referenced", async () => {
    const result = await preview({
      description: "Firmen ohne Website",
      target_type: "company",
      answers: [
        { question_id: "region", value: "oberoesterreich" },
        { question_id: "website", value: "without" },
      ],
    })

    expect(result.plan.empty).toBe(false)
    expect(result.plan.providers.map((p) => p.provider_id)).toContain("web.presence")
  })

  it("counts the rubric's signals toward the cost", async () => {
    // Referencing a signal in a rubric criterion has to plan its provider just
    // like a filter does - otherwise the score would be computed from data
    // nobody fetched.
    const withoutRubric = await preview({
      description: "Firmen",
      target_type: "company",
      answers: [{ question_id: "region", value: "oberoesterreich" }],
    })

    const withRubric = await preview({
      description: "Firmen",
      target_type: "company",
      answers: [{ question_id: "region", value: "oberoesterreich" }],
      rubric: {
        criteria: [
          {
            label: "Keine Website",
            signal: "web.presence.has_website",
            condition: { op: "eq", value: false },
            weight: 50,
            hard: false,
          },
        ],
        threshold: 40,
      },
    })

    expect(withoutRubric.plan.empty).toBe(true)
    expect(withRubric.plan.empty).toBe(false)
  })

  it("fills defaults so a skipped wizard still produces a runnable search", async () => {
    const result = await preview({ description: "Firmen", target_type: "company" })

    expect(result.runnable).toBe(true)
    expect(result.spec.limit).toBe(500)
  })

  it("does not invent a category when filling defaults", async () => {
    const result = await preview({ description: "Firmen", target_type: "company" })
    expect(JSON.stringify(result.spec.filters)).not.toContain("core.category")
  })

  it("returns a share link that decodes back to the same spec", async () => {
    const result = await preview({
      description: "Tischlereien",
      target_type: "company",
      answers: [
        { question_id: "region", value: "oberoesterreich" },
        { question_id: "category", value: ["craft_business"] },
      ],
    })

    const decoded = decodeSearchSpec(result.share_query).spec
    expect(decoded).toStrictEqual(result.spec)
  })

  it("can be asked not to fill defaults", async () => {
    const result = await preview({
      description: "Firmen",
      target_type: "company",
      fill_defaults: false,
    })

    expect(result.runnable).toBe(false)
    expect(result.unanswered).toContain("region")
  })
})

describe("share links", () => {
  it("encodes and decodes a spec through the API", async () => {
    const spec = {
      targetType: "company",
      filters: {
        op: "and",
        children: [{ op: "eq", key: "core.city", value: "Wels" }],
      },
      limit: 100,
    }

    const encoded = await callRoute("post", "/searches/encode", { body: { spec } })
    const query = (encoded.body as { query: string }).query

    const decoded = await callRoute("post", "/searches/decode", { body: { query } })
    expect((decoded.body as { spec: unknown }).spec).toStrictEqual(spec)
  })

  it("rejects a corrupt share link with a validation error", async () => {
    await expect(
      callRoute("post", "/searches/decode", { body: { query: "target_type=company&q=!!!" } })
    ).rejects.toThrow()
  })
})

describe("GET /v1/playbooks", () => {
  it("offers the three starting points", async () => {
    const { body } = await callRoute("get", "/playbooks")
    const data = (body as { data: { slug: string }[] }).data

    expect(data.map((p) => p.slug)).toStrictEqual([
      "website-sales",
      "erp-replacement",
      "market-research",
    ])
  })

  it("carries a runnable spec and a rubric for each", async () => {
    const { body } = await callRoute("get", "/playbooks")
    const data = (
      body as {
        data: { spec: unknown; rubric: { criteria: unknown[] }; share_query: string }[]
      }
    ).data

    for (const playbook of data) {
      expect(playbook.rubric.criteria.length).toBeGreaterThan(0)
      expect(decodeSearchSpec(playbook.share_query).spec).toStrictEqual(playbook.spec)
    }
  })

  it("reports the outreach sequence as absent rather than empty", async () => {
    // M5 has not landed. Null says so; an empty object would suggest messaging
    // exists and does nothing.
    const { body } = await callRoute("get", "/playbooks")
    const data = (body as { data: { sequence: unknown }[] }).data

    expect(data.every((playbook) => playbook.sequence === null)).toBe(true)
  })

  it("lists the signals each playbook's rubric references", async () => {
    const { body } = await callRoute("get", "/playbooks")
    const data = (body as { data: { slug: string; referenced_signals: string[] }[] }).data

    const websiteSales = data.find((p) => p.slug === "website-sales")
    expect(websiteSales?.referenced_signals).toContain("web.presence.has_website")
  })

  it("agrees with the playbook definitions in core", async () => {
    const { body } = await callRoute("get", "/playbooks")
    const data = (body as { data: { slug: string }[] }).data

    expect(data.length).toBe(PLAYBOOKS.length)
  })
})

/**
 * The onboarding profile.
 *
 * Two jobs, and the tests split along them: recording that the wizard ran (so
 * the frontend can hide its entry point), and feeding the answers back into
 * later searches — which is the part that makes filling it in worthwhile.
 */
describe("the onboarding profile", () => {
  const WORKSPACE = { id: "11111111-1111-1111-1111-111111111111", slug: "test" }

  async function onboarding(
    method: "get" | "patch" | "delete",
    body?: unknown,
    seed?: Partial<FakeState>
  ): Promise<JsonResponse> {
    return await callRoute(method, "/onboarding", {
      ...(body !== undefined ? { body } : {}),
      seed: seed ?? { workspaces: [{ ...WORKSPACE }] },
    })
  }

  it("reports a fresh workspace as not onboarded", async () => {
    // This is what makes the frontend show the wizard in the first place.
    const { body } = await onboarding("get")
    const state = body as { profile: unknown; completed: boolean }

    expect(state.completed).toBe(false)
    expect(state.profile).toBeNull()
  })

  it("saves a step without marking the wizard done", async () => {
    const { body } = await onboarding("patch", {
      profile: { target: { region: "tirol" } },
      last_step: 3,
    })
    const state = body as { completed: boolean; last_step: number }

    expect(state.completed).toBe(false)
    expect(state.last_step).toBe(3)
  })

  it("marks it done only when the last step says so", async () => {
    const { body } = await onboarding("patch", { completed: true, last_step: 6 })
    const state = body as { completed: boolean; completed_at: string }

    expect(state.completed).toBe(true)
    expect(state.completed_at).toBeTruthy()
  })

  it("keeps earlier steps when a later one is saved", async () => {
    // The wizard saves after each step; a request carrying only step 3 must not
    // erase what step 2 recorded.
    const seed: Partial<FakeState> = {
      workspaces: [
        { ...WORKSPACE, onboarding: { offer: { description: "Websites für Handwerk" } } },
      ],
    }

    const { body } = await onboarding("patch", { profile: { target: { region: "wien" } } }, seed)
    const state = body as { profile: { offer?: { description?: string } } }

    expect(state.profile.offer?.description).toBe("Websites für Handwerk")
  })

  it("never un-finishes a completed wizard", async () => {
    // A later save must not be able to undo the fact that onboarding happened.
    const seed: Partial<FakeState> = {
      workspaces: [{ ...WORKSPACE, onboarding: { completedAt: "2026-08-01T10:00:00.000Z" } }],
    }

    const { body } = await onboarding("patch", { profile: { lastStep: 2 } }, seed)
    const state = body as { completed: boolean; completed_at: string }

    expect(state.completed).toBe(true)
    expect(state.completed_at).toBe("2026-08-01T10:00:00.000Z")
  })

  it("clears everything when the user restarts onboarding", async () => {
    // Not just the timestamp: someone asking to redo onboarding means the
    // answers too, and keeping them would silently pre-fill the very questions
    // they wanted to revisit.
    const seed: Partial<FakeState> = {
      workspaces: [
        {
          ...WORKSPACE,
          onboarding: { completedAt: "2026-08-01T10:00:00.000Z", target: { region: "wien" } },
        },
      ],
    }

    const { status } = await onboarding("delete", undefined, seed)
    expect(status).toBe(204)
  })

  it("treats an unparseable stored profile as absent", async () => {
    // A row written by an older version must not flow into the search builder
    // unvalidated — asking one question again beats a spec nobody checked.
    const seed: Partial<FakeState> = {
      workspaces: [{ ...WORKSPACE, onboarding: { target: { categories: "nicht-ein-array" } } }],
    }

    const { body } = await onboarding("get", undefined, seed)
    expect((body as { profile: unknown }).profile).toBeNull()
  })
})

describe("the profile feeds into the search", () => {
  it("pre-fills the region, so it is not asked again", async () => {
    // The whole point of the wizard: after onboarding, a bare sentence is
    // enough — no geographic constraint to supply, which Overpass would
    // otherwise refuse outright.
    const seed: Partial<FakeState> = {
      workspaces: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          slug: "test",
          onboarding: {
            target: { region: "oberoesterreich", categories: ["craft_business"] },
            completedAt: "2026-08-01T10:00:00.000Z",
          },
        },
      ],
    }

    const { body } = await callRoute("post", "/searches/clarify", {
      body: { description: "Tischlereien", target_type: "company" },
      seed,
    })
    const result = body as ClarifyBody

    expect(result.runnable).toBe(true)
    expect(result.questions.map((q) => q.id)).not.toContain("region")
    expect(result.questions.map((q) => q.id)).not.toContain("category")
  })

  it("still asks everything when there is no profile", async () => {
    const { body } = await callRoute("post", "/searches/clarify", {
      body: { description: "Tischlereien", target_type: "company" },
    })
    const result = body as ClarifyBody

    expect(result.runnable).toBe(false)
    expect(result.questions.map((q) => q.id)).toContain("region")
  })
})
