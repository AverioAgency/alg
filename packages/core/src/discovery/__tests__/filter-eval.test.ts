import { describe, expect, it } from "vitest"
import { evaluateFilter } from "../filter-eval.js"

/**
 * Der Nachfilter entscheidet, welche Firma im Ergebnis landet, und lief bis
 * hierher ungetestet - was einen Fehler durchliess, der jede Suche leer ausgehen
 * liess (siehe "mehrwertige Felder" unten).
 */

describe("evaluateFilter", () => {
  const restaurant = {
    "core.name": "Gasthaus Krone",
    "core.category": ["restaurant", "cafe"],
    "core.city": "Linz",
    "core.geo": { lat: 48.3069, lon: 14.2858 },
    "core.website": "https://krone.at",
  }

  describe("mehrwertige Felder gegen einwertige Filter", () => {
    // Der Fall aus der Produktion: der Adapter lieferte Treffer, der Nachfilter
    // verwarf alle, und der Lauf meldete "0 Treffer" ohne Fehler - nicht zu
    // unterscheiden von einer Gegend, in der es nichts gibt.

    it("matcht einen Kategoriefilter gegen die Kategorienliste", () => {
      expect(
        evaluateFilter({ op: "eq", key: "core.category", value: "restaurant" }, restaurant)
      ).toBe(true)
    })

    it("matcht unabhaengig von der Gross-/Kleinschreibung", () => {
      expect(
        evaluateFilter({ op: "eq", key: "core.category", value: "Restaurant" }, restaurant)
      ).toBe(true)
    })

    it("matcht nicht, wenn die Kategorie fehlt", () => {
      expect(evaluateFilter({ op: "eq", key: "core.category", value: "bakery" }, restaurant)).toBe(
        false
      )
    })

    it("schliesst mit neq aus, was in der Liste steht", () => {
      // Sonst waere ein Restaurant zugleich "keine Kategorie restaurant".
      expect(
        evaluateFilter({ op: "neq", key: "core.category", value: "restaurant" }, restaurant)
      ).toBe(false)
      expect(evaluateFilter({ op: "neq", key: "core.category", value: "bakery" }, restaurant)).toBe(
        true
      )
    })

    it("laesst Liste gegen Liste Gleichheit bleiben", () => {
      // Die Ueberschneidung zweier Listen ist die Frage von intersects, nicht eq.
      expect(
        evaluateFilter(
          { op: "eq", key: "core.category", value: ["restaurant", "bakery"] },
          restaurant
        )
      ).toBe(false)
      expect(
        evaluateFilter(
          { op: "intersects", key: "core.category", value: ["restaurant", "bakery"] },
          restaurant
        )
      ).toBe(true)
    })

    it("findet die Kategorie auch ueber in", () => {
      expect(
        evaluateFilter(
          { op: "in", key: "core.category", value: ["bakery", "restaurant"] },
          restaurant
        )
      ).toBe(true)
    })
  })

  describe("fehlende Werte", () => {
    it("verwirft einen Vergleich gegen ein Feld, das die Quelle nicht lieferte", () => {
      // "kein Wert" ist keine Antwort auf "ist der Wert X" - und darf vor allem
      // nicht als Treffer durchgehen.
      expect(evaluateFilter({ op: "eq", key: "core.email", value: "a@b.at" }, restaurant)).toBe(
        false
      )
    })

    it("beantwortet exists ohne den Wert zu vergleichen", () => {
      expect(evaluateFilter({ op: "exists", key: "core.website" }, restaurant)).toBe(true)
      expect(evaluateFilter({ op: "exists", key: "core.email" }, restaurant)).toBe(false)
      expect(evaluateFilter({ op: "exists", key: "core.email", value: false }, restaurant)).toBe(
        true
      )
    })
  })

  describe("geo", () => {
    it("haelt einen Punkt innerhalb der bbox", () => {
      expect(
        evaluateFilter(
          { op: "within", key: "core.geo", value: { bbox: [48.2, 14.2, 48.4, 14.4] } },
          restaurant
        )
      ).toBe(true)
    })

    it("verwirft einen Punkt ausserhalb", () => {
      expect(
        evaluateFilter(
          { op: "within", key: "core.geo", value: { bbox: [47.0, 13.0, 47.5, 13.5] } },
          restaurant
        )
      ).toBe(false)
    })
  })

  describe("verknuepfte Knoten", () => {
    it("verlangt bei and jeden Zweig", () => {
      expect(
        evaluateFilter(
          {
            op: "and",
            children: [
              { op: "eq", key: "core.category", value: "restaurant" },
              { op: "eq", key: "core.city", value: "Linz" },
            ],
          },
          restaurant
        )
      ).toBe(true)

      expect(
        evaluateFilter(
          {
            op: "and",
            children: [
              { op: "eq", key: "core.category", value: "restaurant" },
              { op: "eq", key: "core.city", value: "Wels" },
            ],
          },
          restaurant
        )
      ).toBe(false)
    })

    it("kehrt not um", () => {
      expect(
        evaluateFilter(
          { op: "not", child: { op: "eq", key: "core.category", value: "bakery" } },
          restaurant
        )
      ).toBe(true)
    })
  })
})
