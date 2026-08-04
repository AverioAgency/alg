import { describe, expect, it } from "vitest"
import { SignalRegistry } from "../../signals/registry.js"
import { findUnknownFilterKeys } from "../validate-spec.js"

/**
 * Ein erfundener Filterschluessel ist der teuerste stille Fehler im System:
 * kein Adapter bedient ihn, der Nachfilter findet keinen Wert und verwirft
 * jeden Treffer. Der Lauf meldet "0 Leads" ohne Fehler.
 */

/**
 * Eigene Registry statt buildSignalRegistry: @alg/core haengt nicht von
 * @alg/adapters-signals ab, und ein Test-Import waere die einzige Stelle, die
 * das verletzt - im Docker-Build mit --filter faellt so etwas erst spaet auf.
 * Der Test soll ausserdem pruefen, ob die Registry befragt wird, nicht welche
 * Provider gerade registriert sind.
 */
const registry = new SignalRegistry().register({
  id: "web.presence",
  appliesTo: ["local_business", "company"],
  provides: [
    { key: "web.presence.has_website", type: "boolean", labelKey: "signal.web.has_website" },
  ],
  dependsOn: [],
  costPerEntity: 0,
  ttlSeconds: 86_400,
  version: 1,
  run: async () => ({ values: {} }),
})

describe("findUnknownFilterKeys", () => {
  it("accepts core fields", () => {
    const unknown = findUnknownFilterKeys(
      {
        op: "and",
        children: [
          { op: "eq", key: "core.category", value: "restaurant" },
          { op: "within", key: "core.geo", value: { bbox: [48, 14, 49, 15] } },
          { op: "contains", key: "core.city", value: "Linz" },
        ],
      },
      registry
    )
    expect(unknown).toStrictEqual([])
  })

  it("accepts a signal the registry actually provides", () => {
    const unknown = findUnknownFilterKeys(
      { op: "eq", key: "web.presence.has_website", value: false },
      registry
    )
    expect(unknown).toStrictEqual([])
  })

  it("rejects the keys the sidebar invented", () => {
    // Genau die fuenf Namen aus dem Frontend. Der Kommentar dort sagte
    // "gegen /filters/schema verifizieren, sobald ein Workspace erreichbar
    // ist" - das ist nie passiert, und jede Suche mit gesetztem Bundesland
    // lief garantiert leer aus.
    const unknown = findUnknownFilterKeys(
      {
        op: "and",
        children: [
          { op: "eq", key: "geo.state", value: "Oberösterreich" },
          { op: "contains", key: "geo.city", value: "Linz" },
          { op: "contains", key: "industry", value: "Gastro" },
          { op: "gte", key: "gmb.rating", value: 4 },
          { op: "gte", key: "gmb.reviews_count", value: 10 },
        ],
      },
      registry
    )

    expect(unknown.map((entry) => entry.key)).toStrictEqual([
      "geo.state",
      "geo.city",
      "industry",
      "gmb.rating",
      "gmb.reviews_count",
    ])
  })

  it("suggests the real key instead of only saying no", () => {
    // "geo.city" und "core.city" teilen keinen Praefix, meinen aber dasselbe -
    // ohne Vorschlag muss man erst herausfinden, dass es eine Liste gibt.
    const [cityKey] = findUnknownFilterKeys({ op: "eq", key: "geo.city", value: "Linz" }, registry)
    expect(cityKey?.didYouMean).toContain("core.city")
  })

  it("looks inside nested and negated nodes", () => {
    const unknown = findUnknownFilterKeys(
      {
        op: "and",
        children: [
          { op: "eq", key: "core.category", value: "restaurant" },
          { op: "not", child: { op: "eq", key: "erfunden.schluessel", value: 1 } },
        ],
      },
      registry
    )
    expect(unknown.map((entry) => entry.key)).toStrictEqual(["erfunden.schluessel"])
  })

  it("reports each unknown key once", () => {
    const unknown = findUnknownFilterKeys(
      {
        op: "or",
        children: [
          { op: "eq", key: "geo.state", value: "Wien" },
          { op: "eq", key: "geo.state", value: "Tirol" },
        ],
      },
      registry
    )
    expect(unknown).toHaveLength(1)
  })

  it("passes an empty filter tree", () => {
    // Eine Suche ohne Filter ist zulaessig und heisst "alles, was die Adapter
    // liefern" - sie darf nicht an der Schluesselpruefung scheitern.
    expect(findUnknownFilterKeys({ op: "and", children: [] }, registry)).toStrictEqual([])
  })
})
