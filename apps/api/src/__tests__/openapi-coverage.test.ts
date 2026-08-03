import { describe, expect, it } from "vitest"
import { type Router } from "express"
import { buildSignalRegistry } from "@alg/adapters-signals"
import { openApiDocument } from "../openapi.js"
import { createClarifyRouter } from "../routes/clarify.js"
import { createCompaniesRouter } from "../routes/companies.js"
import { createFilesRouter } from "../routes/files.js"
import { createHealthRouter } from "../routes/health.js"
import { createRubricsRouter } from "../routes/rubrics.js"
import { createSearchesRouter } from "../routes/searches.js"
import { createSignalsRouter } from "../routes/signals.js"
import { createStreamsRouter } from "../routes/streams.js"

/**
 * The OpenAPI document must describe exactly the routes that exist.
 *
 * It is not decoration: the frontend generates its client from it, and /docs is
 * rendered from it. A documented route that does not exist produces a client
 * method that 404s; an undocumented route is invisible to whoever builds the UI.
 * Both directions are checked, because both have bitten this project.
 */

/** Nothing here is called - the routers only get inspected for their routes. */
const NOT_USED = undefined as never

function allRouters(): Router[] {
  const registry = buildSignalRegistry({ userAgent: "AlgBot/1.0" })

  return [
    createHealthRouter({
      db: NOT_USED,
      redis: NOT_USED,
      storage: NOT_USED,
      version: "0.0.0",
      sendingEnabled: false,
    }),
    createFilesRouter({ db: NOT_USED, storage: NOT_USED, signingSecret: "x".repeat(32) }),
    createCompaniesRouter({ db: NOT_USED }),
    createSearchesRouter({ db: NOT_USED, discoveryQueue: NOT_USED }),
    createStreamsRouter({ db: NOT_USED }),
    createSignalsRouter({ db: NOT_USED, registry, enrichmentQueue: NOT_USED }),
    createRubricsRouter({
      db: NOT_USED,
      registry,
      scoringQueue: NOT_USED,
      llmClient: null,
    }),
    createClarifyRouter({ db: NOT_USED, registry }),
  ]
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const

/** "GET /rubrics/:id" for every route Express actually serves. */
function registeredRoutes(): Set<string> {
  const routes = new Set<string>()

  for (const router of allRouters()) {
    for (const layer of router.stack) {
      if (!layer.route) continue
      for (const method of HTTP_METHODS) {
        if (layer.route.methods[method]) {
          routes.add(`${method.toUpperCase()} ${layer.route.path}`)
        }
      }
    }
  }

  return routes
}

/** The same shape, from the document. OpenAPI writes {id} where Express writes :id. */
function documentedRoutes(): Set<string> {
  const doc = openApiDocument("0.0.0")
  const paths = doc.paths as Record<string, Record<string, unknown>>
  const routes = new Set<string>()

  for (const [path, operations] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      if (operations[method]) {
        routes.add(`${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ":$1")}`)
      }
    }
  }

  return routes
}

describe("the OpenAPI document and the router agree", () => {
  it("documents every route the API serves", () => {
    const undocumented = [...registeredRoutes()]
      .filter((route) => !documentedRoutes().has(route))
      .sort()

    // An undocumented route is invisible to whoever builds the frontend, and to
    // /docs, which is generated from this document.
    expect(undocumented).toStrictEqual([])
  })

  it("documents no route the API does not serve", () => {
    const phantom = [...documentedRoutes()].filter((route) => !registeredRoutes().has(route)).sort()

    // The worse direction: a generated client method that 404s at runtime.
    expect(phantom).toStrictEqual([])
  })

  it("resolves every $ref", () => {
    const doc = openApiDocument("0.0.0")
    const json = JSON.stringify(doc)
    const refs = [...new Set([...json.matchAll(/"\$ref":"([^"]+)"/g)].map((m) => m[1]))]

    const broken = refs.filter((ref) => {
      let current: unknown = doc
      for (const segment of ref.replace(/^#\//, "").split("/")) {
        if (typeof current !== "object" || current === null) return true
        current = Reflect.get(current, segment)
      }
      return current === undefined
    })

    expect(broken).toStrictEqual([])
    expect(refs.length).toBeGreaterThan(0)
  })

  it("gives every operation a summary, so /docs has something to show", () => {
    const doc = openApiDocument("0.0.0")
    const paths = doc.paths as Record<string, Record<string, { summary?: string }>>
    const nameless: string[] = []

    for (const [path, operations] of Object.entries(paths)) {
      for (const method of HTTP_METHODS) {
        const operation = operations[method]
        if (operation && !operation.summary) nameless.push(`${method.toUpperCase()} ${path}`)
      }
    }

    expect(nameless).toStrictEqual([])
  })
})
