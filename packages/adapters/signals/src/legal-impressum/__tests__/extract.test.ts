import { describe, expect, it } from "vitest"
import { extractImpressum, findImpressumLinks, htmlToText } from "../extract.js"

/**
 * The shapes here are taken from how Austrian Impressum pages are actually
 * written - obfuscated addresses, "FN 123456a", umlauts as entities. Each case
 * is a real pattern, not a hypothetical one.
 */

const AUSTRIAN_IMPRESSUM = `
<!DOCTYPE html><html><head><title>Impressum</title></head><body>
<h1>Impressum</h1>
<p>Angaben gem&auml;&szlig; &sect;5 ECG</p>
<p>Muster Produktion GmbH<br>
Industriestra&szlig;e 5<br>
4600 Wels, &Ouml;sterreich</p>
<p>Telefon: +43 7242 123456<br>
E-Mail: <a href="mailto:office@muster-produktion.at">office@muster-produktion.at</a></p>
<p>Firmenbuchnummer: FN 123456a<br>
Firmenbuchgericht: Landesgericht Wels<br>
UID-Nummer: ATU12345678</p>
<p>Gesch&auml;ftsf&uuml;hrer: Ing. Max Mustermann</p>
<p>Datenschutz: <a href="mailto:datenschutz@muster-produktion.at">datenschutz@...</a></p>
</body></html>
`

describe("htmlToText", () => {
  it("decodes the entities that appear in German contact data", () => {
    const text = htmlToText("<p>Industriestra&szlig;e 5, &Ouml;sterreich</p>")
    expect(text).toContain("Industriestraße")
    expect(text).toContain("Österreich")
  })

  it("removes scripts and styles rather than reading their contents", () => {
    // A tracking script full of email-looking strings would otherwise pollute
    // the extraction.
    const text = htmlToText('<script>var a="fake@evil.com"</script><p>echt@muster.at</p>')
    expect(text).not.toContain("fake@evil.com")
    expect(text).toContain("echt@muster.at")
  })

  it("turns block elements into line breaks", () => {
    expect(htmlToText("<p>Zeile 1</p><p>Zeile 2</p>")).toBe("Zeile 1\nZeile 2")
  })

  it("decodes numeric entities", () => {
    expect(htmlToText("&#79;&#102;&#102;&#105;&#99;&#101;")).toBe("Office")
  })
})

describe("extractImpressum", () => {
  it("extracts everything from a typical Austrian Impressum", () => {
    const data = extractImpressum(AUSTRIAN_IMPRESSUM, "muster-produktion.at")

    expect(data.looksLikeImpressum).toBe(true)
    expect(data.email).toBe("office@muster-produktion.at")
    expect(data.companyRegisterNumber).toBe("FN 123456a")
    expect(data.vatId).toBe("ATU12345678")
    expect(data.phone).toContain("43 7242 123456")
    expect(data.managingDirectors[0]).toContain("Max Mustermann")
  })

  it("prefers the contact address over the privacy one", () => {
    // An outreach message should go to office@, not datenschutz@.
    const data = extractImpressum(AUSTRIAN_IMPRESSUM, "muster-produktion.at")
    expect(data.email).toBe("office@muster-produktion.at")
  })

  it("prefers an address on the company's own domain", () => {
    const html = `
      <p>Impressum</p>
      <a href="mailto:kontakt@agentur-die-die-seite-baute.at">Webdesign</a>
      <a href="mailto:info@muster.at">Kontakt</a>
    `
    expect(extractImpressum(html, "muster.at").email).toBe("info@muster.at")
  })

  it("reads an address from a mailto link when the text is obfuscated", () => {
    const html = '<p>Impressum</p><a href="mailto:office@muster.at">E-Mail schreiben</a>'
    expect(extractImpressum(html, "muster.at").email).toBe("office@muster.at")
  })

  it("handles the (at) obfuscation", () => {
    const html = "<p>Impressum</p><p>office (at) muster.at</p>"
    expect(extractImpressum(html, "muster.at").email).toBe("office@muster.at")
  })

  it("does not mistake an image filename for an address", () => {
    const html = '<p>Impressum</p><img src="logo@2x.png"><p>echt@muster.at</p>'
    expect(extractImpressum(html, "muster.at").email).toBe("echt@muster.at")
  })

  it("recognizes a German Impressum", () => {
    const html = `
      <h1>Impressum</h1>
      <p>Angaben gemäß § 5 TMG</p>
      <p>Beispiel GmbH, Hauptstraße 1, 80331 München</p>
      <p>Telefon: 089 1234567</p>
      <p>E-Mail: info@beispiel.de</p>
      <p>USt-IdNr.: DE123456789</p>
    `
    const data = extractImpressum(html, "beispiel.de")

    expect(data.looksLikeImpressum).toBe(true)
    expect(data.email).toBe("info@beispiel.de")
    expect(data.vatId).toBe("DE123456789")
  })

  it("marks a page that is not an Impressum", () => {
    // A soft-404 returning 200 is common; the caller needs to tell the difference.
    const data = extractImpressum("<html><body><h1>Willkommen</h1></body></html>")
    expect(data.looksLikeImpressum).toBe(false)
    expect(data.email).toBeNull()
  })

  it("returns nulls rather than throwing on empty input", () => {
    const data = extractImpressum("")
    expect(data.email).toBeNull()
    expect(data.phone).toBeNull()
    expect(data.managingDirectors).toStrictEqual([])
  })

  it("only takes a phone number that is labelled as one", () => {
    // An unlabelled number is as likely to be a postcode or a price.
    const html = "<p>Impressum</p><p>Hauptplatz 8, 4020 Linz</p><p>Preis: 1234567</p>"
    expect(extractImpressum(html).phone).toBeNull()
  })

  it("caps the number of managing directors it reports", () => {
    const html =
      "<p>Impressum</p>" +
      Array.from({ length: 10 }, (_, i) => `<p>Geschäftsführer: Person ${i}</p>`).join("")
    expect(extractImpressum(html).managingDirectors.length).toBeLessThanOrEqual(3)
  })
})

describe("findImpressumLinks", () => {
  it("finds a link by its label", () => {
    const html = '<a href="/ueber-uns/rechtliches">Impressum</a>'
    expect(findImpressumLinks(html, "https://muster.at")).toStrictEqual([
      "https://muster.at/ueber-uns/rechtliches",
    ])
  })

  it("finds a link by its href", () => {
    const html = '<a href="/impressum">Rechtliches</a>'
    expect(findImpressumLinks(html, "https://muster.at")).toContain("https://muster.at/impressum")
  })

  it("resolves a relative href against the base", () => {
    const html = '<a href="impressum.html">Impressum</a>'
    expect(findImpressumLinks(html, "https://muster.at/de/")).toStrictEqual([
      "https://muster.at/de/impressum.html",
    ])
  })

  it("ignores a javascript: href", () => {
    const html = '<a href="javascript:void(0)">Impressum</a>'
    expect(findImpressumLinks(html, "https://muster.at")).toStrictEqual([])
  })

  it("caps how many candidates it returns", () => {
    const html = Array.from(
      { length: 20 },
      (_, i) => `<a href="/impressum-${i}">Impressum</a>`
    ).join("")
    expect(findImpressumLinks(html, "https://muster.at").length).toBeLessThanOrEqual(5)
  })

  it("survives a malformed href", () => {
    const html = '<a href="ht!tp://broken">Impressum</a>'
    expect(() => findImpressumLinks(html, "https://muster.at")).not.toThrow()
  })
})
