import { describe, expect, it } from "vitest"
import { evaluateFilter } from "../filter-eval.js"
import { discoveryTimeFilters } from "../run.js"

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

describe("discoveryTimeFilters", () => {
  /**
   * Der zweite Grund, warum Suchen leer zurueckkamen: "Betriebe ohne Website"
   * prueft ein Signal, das erst die Anreicherung ermittelt. Zur Discovery-Zeit
   * fehlt der Wert, der Nachfilter liest das zu Recht als "passt nicht" - und
   * verwarf damit jeden Treffer, den Google gerade berechnet hatte.
   */
  const geo = { op: "within" as const, key: "core.geo", value: { bbox: [48, 14, 49, 15] } }
  const city = { op: "contains" as const, key: "core.city", value: "Linz" }
  const signal = { op: "eq" as const, key: "web.presence.has_website", value: false }
  const category = { op: "eq" as const, key: "core.category", value: "restaurant" }

  it("behaelt nachpruefbare Kernfelder", () => {
    expect(discoveryTimeFilters(city)).toEqual(city)
    expect(discoveryTimeFilters(geo)).toEqual(geo)
  })

  it("entfernt core.category, weil Slug und Quellvokabular nicht vergleichbar sind", () => {
    // Der Filter traegt "restaurant" als Slug, Overpass liefert rohe OSM-Werte
    // und Places Google-Typen. Der Vergleich traf nie: fuenf passende Betriebe
    // rein, null raus. Beide Adapter suchen ohnehin bereits danach.
    expect(discoveryTimeFilters(category)).toBeNull()
  })

  it("entfernt einen Signalfilter", () => {
    expect(discoveryTimeFilters(signal)).toBeNull()
  })

  it("laesst von einem gemischten AND nur das Pruefbare uebrig", () => {
    expect(discoveryTimeFilters({ op: "and", children: [city, signal] })).toEqual(city)
  })

  it("behaelt beide pruefbaren Kernfelder eines AND", () => {
    expect(discoveryTimeFilters({ op: "and", children: [city, geo, signal] })).toEqual({
      op: "and",
      children: [city, geo],
    })
  })

  it("laesst von einer Wizard-Spec Geo und Ort uebrig", () => {
    // Genau die Spec, die returned: 5, found: 0 lieferte.
    expect(discoveryTimeFilters({ op: "and", children: [geo, category, city] })).toEqual({
      op: "and",
      children: [geo, city],
    })
  })

  it("gibt null zurueck, wenn nichts Pruefbares uebrig bleibt", () => {
    // Der Aufrufer filtert dann gar nicht, statt gegen ein leeres AND zu pruefen.
    expect(discoveryTimeFilters({ op: "and", children: [signal] })).toBeNull()
  })

  it("laesst die Negation eines Signals ebenfalls fallen", () => {
    // Nicht pruefbar bleibt nicht pruefbar - "nicht X" ist nicht "trifft zu".
    expect(discoveryTimeFilters({ op: "not", child: signal })).toBeNull()
    expect(discoveryTimeFilters({ op: "not", child: city })).toEqual({
      op: "not",
      child: city,
    })
  })

  it("ein Restaurant ueberlebt den Nachfilter der Wizard-Suche", () => {
    // Ende zu Ende: genau die Spec, die "0 Treffer" lieferte.
    const fromGoogle = {
      "core.name": "Gasthaus Krone",
      "core.category": ["restaurant"],
      "core.city": "Linz",
      "core.geo": { lat: 48.3, lon: 14.28 },
    }
    const wizardSpec = { op: "and" as const, children: [city, geo, signal] }

    expect(evaluateFilter(wizardSpec, fromGoogle)).toBe(false)
    const applicable = discoveryTimeFilters(wizardSpec)
    expect(applicable).not.toBeNull()
    expect(evaluateFilter(applicable!, fromGoogle)).toBe(true)
  })
})
