import { describe, expect, it } from "vitest"
import { buildSignalRegistry } from "@alg/adapters-signals"
import { CATEGORY_SLUGS, categoriesFor, coreFieldsFor } from "@alg/shared"
import { createSignalsRouter } from "../routes/signals.js"

/**
 * GET /v1/filters/schema.
 *
 * The document the filter UI is built from. Three sources are merged here - the
 * core.* fields discovery supplies, the signals providers produce, and the
 * category vocabulary - so a mistake in the merge shows up as a filter row the
 * user can build but the engine cannot serve.
 */

interface JsonResponse {
  body: unknown
  status: number
}

/** Calls one route handler directly; the app has no HTTP test harness. */
async function callRoute(path: string, query: Record<string, string> = {}): Promise<JsonResponse> {
  const registry = buildSignalRegistry({ userAgent: "AlgBot/1.0" })
  const router = createSignalsRouter({
    // Never touched by this route, which only reads the registry.
    db: undefined as never,
    registry,
    enrichmentQueue: undefined as never,
  })

  const layer = router.stack.find(
    (entry) => entry.route?.path === path && entry.route.methods.get === true
  )
  if (!layer?.route) throw new Error(`Route ${path} is not registered`)

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
    }

    const req = {
      query,
      params: {},
      // requireContext reads req.ctx; the route needs a workspace, not a database.
      ctx: { workspaceId: "11111111-1111-1111-1111-111111111111", userId: "u1" },
    }

    handler(req as never, res as never, (error?: unknown) => {
      reject(error instanceof Error ? error : new Error(String(error)))
    })
  })
}

interface SchemaBody {
  target_type: string | null
  fields: {
    key: string
    kind: "core" | "signal"
    type: string
    operators: string[]
    label_key: string
    pushed_down_by: string[]
    cost_per_entity_eur: number
    enum_values?: string[]
  }[]
  categories: { slug: string; label_key: string; target_type: string }[]
  operators: string[]
  unary_operators: string[]
}

async function schemaFor(targetType?: string): Promise<SchemaBody> {
  const { body } = await callRoute("/filters/schema", targetType ? { target_type: targetType } : {})
  return body as SchemaBody
}

describe("GET /v1/filters/schema", () => {
  it("returns core fields and signals in one list", async () => {
    const schema = await schemaFor("company")

    const core = schema.fields.filter((field) => field.kind === "core")
    const signals = schema.fields.filter((field) => field.kind === "signal")

    expect(core.length).toBe(coreFieldsFor("company").length)
    expect(signals.length).toBeGreaterThan(0)
  })

  it("marks core fields as free", async () => {
    // Discovery already supplies them, so referencing one starts no provider.
    const schema = await schemaFor("company")
    const core = schema.fields.filter((field) => field.kind === "core")

    expect(core.every((field) => field.cost_per_entity_eur === 0)).toBe(true)
  })

  it("prices each signal by the provider that produces it", async () => {
    // The point of showing it here: the user sees the price while building the
    // filter, not after the run.
    const schema = await schemaFor("company")
    const signals = schema.fields.filter((field) => field.kind === "signal")

    expect(signals.every((field) => typeof field.cost_per_entity_eur === "number")).toBe(true)
    expect(signals.every((field) => field.cost_per_entity_eur >= 0)).toBe(true)
  })

  it("says which core fields a source can pre-filter on", async () => {
    // An empty list means every adapter fetches first and filters afterwards -
    // slower, and on a paid source more expensive.
    const schema = await schemaFor("company")
    const geo = schema.fields.find((field) => field.key === "core.geo")
    const domain = schema.fields.find((field) => field.key === "core.domain")

    expect(geo?.pushed_down_by).toContain("overpass")
    // Normalized on our side after fetching, so no source can pre-filter on it.
    expect(domain?.pushed_down_by).toStrictEqual([])
  })

  it("never claims a signal can be pushed down", async () => {
    // A signal exists only after its provider ran, so no discovery source can
    // filter on it at the source. Claiming otherwise would promise a cheap
    // search that is not cheap.
    const schema = await schemaFor("company")
    const signals = schema.fields.filter((field) => field.kind === "signal")

    expect(signals.every((field) => field.pushed_down_by.length === 0)).toBe(true)
  })

  it("offers only the categories that suit the target type", async () => {
    const company = await schemaFor("company")
    const local = await schemaFor("local_business")

    expect(company.categories.map((c) => c.slug)).toContain("craft_business")
    expect(company.categories.map((c) => c.slug)).not.toContain("restaurant")
    expect(local.categories.map((c) => c.slug)).toContain("restaurant")
  })

  it("returns German labels as i18n keys, never as strings", async () => {
    // User-visible strings are the frontend's business; a German string in this
    // payload would be untranslatable and would break the other repository.
    const schema = await schemaFor("company")

    expect(schema.fields.every((field) => field.label_key.includes("."))).toBe(true)
    expect(schema.categories.every((category) => category.label_key.startsWith("category."))).toBe(
      true
    )
  })

  it("lists every operator, and which of them take no value", async () => {
    const schema = await schemaFor("company")

    expect(schema.operators).toContain("within")
    expect(schema.operators).toContain("contains")
    // exists is unary: the UI must not render a value input for it.
    expect(schema.unary_operators).toStrictEqual(["exists"])
  })

  it("returns everything when no target type is given", async () => {
    const all = await schemaFor()
    const company = await schemaFor("company")

    expect(all.target_type).toBeNull()
    expect(all.categories.length).toBe(CATEGORY_SLUGS.length)
    expect(all.categories.length).toBeGreaterThan(company.categories.length)
  })

  it("agrees with the category vocabulary", async () => {
    const schema = await schemaFor("local_business")
    const expected = categoriesFor("local_business").map((category) => category.slug)

    expect(schema.categories.map((category) => category.slug)).toStrictEqual(expected)
  })

  it("gives every field an operator list the UI can render", async () => {
    // A field with no operators is a row the user cannot complete.
    const schema = await schemaFor("company")

    expect(schema.fields.every((field) => field.operators.length > 0)).toBe(true)
  })
})
