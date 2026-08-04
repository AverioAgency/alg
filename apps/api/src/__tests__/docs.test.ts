import { describe, expect, it } from "vitest"
import { renderDocsPage } from "../docs.js"
import { openApiDocument } from "../openapi.js"

/**
 * The /docs page.
 *
 * Generated from the OpenAPI document, so what is worth testing is that nothing
 * falls through the grouping on the way: an endpoint that matches no section
 * would silently vanish from the page while still existing in the API.
 */

const doc = openApiDocument("0.1.0")
const html = renderDocsPage(doc, "0.1.0")

describe("renderDocsPage", () => {
  it("shows every path the document describes", () => {
    const paths = Object.keys(doc.paths as Record<string, unknown>)
    const missing = paths.filter((path) => !html.includes(`>${path}<`))

    expect(missing).toStrictEqual([])
    expect(paths.length).toBeGreaterThan(30)
  })

  it("groups the onboarding endpoints first, where a new frontend starts", () => {
    const onboarding = html.indexOf('id="onboarding"')
    const operations = html.indexOf('id="betrieb"')

    expect(onboarding).toBeGreaterThan(-1)
    expect(onboarding).toBeLessThan(operations)
  })

  it("explains both ways in", () => {
    // The single most common reason a first request fails. Since the Nexoro
    // backend uses the service path and never sees a Supabase token, a page
    // documenting only the JWT would send whoever wires it up down the wrong
    // road entirely.
    expect(html).toContain("x-alg-service-token")
    expect(html).toContain("x-workspace-slug")
    expect(html).toContain("x-workspace-id")
    expect(html).toContain("Authorization: Bearer")
  })

  it("says plainly that the service token must not reach a browser", () => {
    // It is the whole tenant boundary on that path; someone copying it into
    // frontend code would hand every visitor access to every workspace.
    expect(html).toContain("nie in einen Browser")
  })

  it("links to the machine-readable document", () => {
    expect(html).toContain("/v1/openapi.json")
  })

  it("escapes text rather than injecting it", () => {
    // Descriptions are authored in this repository, but the page is public and
    // rendered by hand - a stray angle bracket must not become markup.
    const hostile = {
      paths: {
        "/x": {
          get: {
            summary: '<script>alert("xss")</script>',
            description: "a & b < c",
            responses: { "200": { description: "</section><script>bad()</script>" } },
          },
        },
      },
    }

    const rendered = renderDocsPage(hostile, "0.0.0")
    expect(rendered).not.toContain("<script>alert")
    expect(rendered).not.toContain("<script>bad()")
    expect(rendered).toContain("&lt;script&gt;")
  })

  it("is a complete, self-contained document", () => {
    // No CDN: this API runs behind Helmet and a strict CSP, and a script from
    // someone else's origin is a supply-chain dependency for rendering a list.
    expect(html.startsWith("<!doctype html>")).toBe(true)
    expect(html).toContain("</html>")
    expect(html).not.toMatch(/<script[\s>]/)
    expect(html).not.toContain("https://cdn")
  })

  it("marks required parameters", () => {
    expect(html).toContain('class="req"')
  })

  it("survives a document with no paths at all", () => {
    const empty = renderDocsPage({ paths: {} }, "0.0.0")
    expect(empty).toContain("</html>")
  })
})
