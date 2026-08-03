import { describe, expect, it } from "vitest"
import { CsvAdapter } from "../adapter.js"
import { CsvParseError, detectDelimiter, mapHeaders, parseCsv } from "../parse.js"

/**
 * The input here is a file a user exported from somewhere. Most of these cases
 * are things real exports actually do - Excel's semicolons, a BOM, quoted commas
 * - and each one would silently import the wrong thing if unhandled.
 */

describe("parseCsv", () => {
  it("parses a plain comma file", () => {
    expect(parseCsv("a,b,c\n1,2,3")).toStrictEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ])
  })

  it("handles CRLF line endings", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toStrictEqual([
      ["a", "b"],
      ["1", "2"],
    ])
  })

  it("strips the UTF-8 BOM Excel writes", () => {
    // Without this the first column name would carry the BOM and never match.
    const rows = parseCsv("\uFEFFname,city\nMuster,Linz")
    expect(rows[0]).toStrictEqual(["name", "city"])
  })

  it("keeps a delimiter inside a quoted field", () => {
    const rows = parseCsv('name,address\n"Muster, Handel GmbH","Hauptplatz 1, Linz"')
    expect(rows[1]).toStrictEqual(["Muster, Handel GmbH", "Hauptplatz 1, Linz"])
  })

  it("unescapes doubled quotes", () => {
    const rows = parseCsv('name\n"Gasthaus ""Zur Post"""')
    expect(rows[1]?.[0]).toBe('Gasthaus "Zur Post"')
  })

  it("keeps newlines inside a quoted field", () => {
    const rows = parseCsv('name,note\nMuster,"Zeile 1\nZeile 2"')
    expect(rows).toHaveLength(2)
    expect(rows[1]?.[1]).toBe("Zeile 1\nZeile 2")
  })

  it("skips blank lines", () => {
    expect(parseCsv("a,b\n\n1,2\n\n")).toHaveLength(2)
  })

  it("parses a final row without a trailing newline", () => {
    expect(parseCsv("a,b\n1,2")).toHaveLength(2)
  })

  it("rejects an unterminated quote instead of guessing", () => {
    expect(() => parseCsv('name\n"nie geschlossen')).toThrow(CsvParseError)
  })

  it("enforces the row cap", () => {
    const many = ["name", ...Array.from({ length: 200 }, (_, i) => `Firma ${i}`)].join("\n")
    expect(() => parseCsv(many, { maxRows: 50 })).toThrow(CsvParseError)
  })
})

describe("detectDelimiter", () => {
  it("detects the semicolon a German Excel writes", () => {
    // The common case that would otherwise parse as one column and import nothing.
    expect(detectDelimiter("name;plz;ort\nMuster;4020;Linz")).toBe(";")
  })

  it("detects comma, tab and pipe", () => {
    expect(detectDelimiter("a,b,c")).toBe(",")
    expect(detectDelimiter("a\tb\tc")).toBe("\t")
    expect(detectDelimiter("a|b|c")).toBe("|")
  })

  it("ignores delimiters inside quotes when counting", () => {
    expect(detectDelimiter('"a;b;c;d";x')).toBe(";")
  })
})

describe("mapHeaders", () => {
  it("maps German headers", () => {
    const { columns } = mapHeaders(["Firma", "Straße", "PLZ", "Ort", "Telefon", "Webseite"])
    expect(columns).toMatchObject({
      name: 0,
      street: 1,
      postalCode: 2,
      city: 3,
      phone: 4,
      website: 5,
    })
  })

  it("maps English headers", () => {
    const { columns } = mapHeaders(["Company Name", "Street", "ZIP", "City", "Phone", "Website"])
    expect(columns).toMatchObject({ name: 0, postalCode: 2, city: 3 })
  })

  it("is tolerant of case, spacing and separators", () => {
    const { columns } = mapHeaders(["  FIRMEN_NAME  ", "e-mail", "Postal Code"])
    expect(columns.email).toBe(1)
    expect(columns.postalCode).toBe(2)
  })

  it("reports headers it does not recognize", () => {
    const { unmapped } = mapHeaders(["Firma", "Umsatz 2025", "Kategorie"])
    expect(unmapped.map((u) => u.header)).toStrictEqual(["Umsatz 2025", "Kategorie"])
  })

  it("keeps the leftmost of two equivalent columns", () => {
    const { columns } = mapHeaders(["Firma", "Unternehmen"])
    expect(columns.name).toBe(0)
  })
})

describe("CsvAdapter", () => {
  const csv = [
    "Firma;Straße;Hausnummer;PLZ;Ort;Land;Telefon;E-Mail;Webseite",
    "Muster Produktion GmbH;Industriestraße;5;4600;Wels;Österreich;0732 123456;office@muster.at;www.muster.at",
    "Beispiel Handel e.U.;Hauptplatz;12;4020;Linz;AT;+43 732 998877;;beispiel.at",
    ";;;;;;;;",
    "Nur Name GmbH;;;;;;;;",
  ].join("\n")

  it("serves every target type - a CSV can describe anything", () => {
    const adapter = new CsvAdapter({ content: csv })
    expect(adapter.targetTypes).toContain("company")
    expect(adapter.targetTypes).toContain("person")
    expect(adapter.targetTypes).toContain("local_business")
  })

  it("pushes down no filters: a file has no query interface", () => {
    expect(new CsvAdapter({ content: csv }).supports).toStrictEqual([])
  })

  it("imports rows with a semicolon delimiter", () => {
    const result = new CsvAdapter({ content: csv }).import()

    expect(result.entities).toHaveLength(3)
    expect(result.entities.map((e) => e.name)).toStrictEqual([
      "Muster Produktion GmbH",
      "Beispiel Handel e.U.",
      "Nur Name GmbH",
    ])
  })

  it("maps address fields", () => {
    const [first] = new CsvAdapter({ content: csv }).import().entities

    expect(first?.address).toMatchObject({
      street: "Industriestraße",
      house_number: "5",
      postal_code: "4600",
      city: "Wels",
      country: "AT",
    })
  })

  it("normalizes a spelled-out country name", () => {
    const entities = new CsvAdapter({ content: csv }).import().entities
    expect(entities[0]?.address?.country).toBe("AT")
    expect(entities[1]?.address?.country).toBe("AT")
  })

  it("treats an empty cell as absent rather than an empty string", () => {
    const [, second] = new CsvAdapter({ content: csv }).import().entities
    expect(second?.email).toBeUndefined()
  })

  it("reports skipped rows instead of dropping them silently", () => {
    // Importing 3 of 4 rows without saying so would look like success.
    const result = new CsvAdapter({ content: csv }).import()
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]?.reason).toContain("kein Firmenname")
  })

  it("points at the right line number, counting the header", () => {
    const result = new CsvAdapter({ content: "Firma\nA\n\nB\n;\n" }).import()
    expect(result.skipped.every((s) => s.line >= 2)).toBe(true)
  })

  it("keeps the untouched row for later re-normalization", () => {
    const [first] = new CsvAdapter({ content: csv }).import().entities
    expect(first?.raw).toMatchObject({ Firma: "Muster Produktion GmbH", PLZ: "4600" })
  })

  it("uses an id column when present, otherwise a synthetic one", () => {
    const withId = new CsvAdapter({
      content: "Kundennummer;Firma\nK-1001;Muster GmbH",
    }).import()
    expect(withId.entities[0]?.sourceId).toBe("K-1001")

    const withoutId = new CsvAdapter({ content: "Firma\nMuster GmbH", importId: "imp7" }).import()
    expect(withoutId.entities[0]?.sourceId).toBe("imp7:2")
  })

  it("reports unrecognized headers so the user can fix the file", () => {
    const result = new CsvAdapter({ content: "Firma;Umsatz;Mitarbeiter\nA;100;5" }).import()
    expect(result.unmappedHeaders).toStrictEqual(["Umsatz", "Mitarbeiter"])
  })

  it("refuses a file without a name column", () => {
    expect(() => new CsvAdapter({ content: "PLZ;Ort\n4020;Linz" }).import()).toThrow(/Firmennamen/)
  })

  it("handles an empty file", () => {
    const result = new CsvAdapter({ content: "" }).import()
    expect(result.entities).toStrictEqual([])
    expect(result.totalRows).toBe(0)
  })

  it("respects a limit", () => {
    expect(new CsvAdapter({ content: csv }).import(2).entities).toHaveLength(2)
  })

  it("costs nothing and makes no external request", () => {
    const estimate = new CsvAdapter({ content: csv }).estimateCost({
      targetType: "company",
      filters: { op: "and", children: [] },
    })
    expect(estimate.estimatedCostEur).toBe(0)
    expect(estimate.degraded).toBe(false)
  })
})
