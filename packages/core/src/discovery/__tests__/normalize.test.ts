import { describe, expect, it } from "vitest"
import {
  cleanString,
  normalizeCompanyName,
  normalizeCountryCode,
  normalizeDomain,
  normalizeEmail,
  normalizePhone,
  normalizePostalCode,
  normalizeWebsite,
} from "../normalize.js"

describe("normalizeDomain", () => {
  it("reduces URLs to a registrable domain", () => {
    for (const input of [
      "https://www.muster-produktion.at/kontakt?ref=x",
      "http://muster-produktion.at",
      "www.muster-produktion.at",
      "MUSTER-PRODUKTION.AT",
      "  muster-produktion.at  ",
      "https://muster-produktion.at:8443/",
    ]) {
      expect(normalizeDomain(input), input).toBe("muster-produktion.at")
    }
  })

  it("keeps subdomains that are not www", () => {
    expect(normalizeDomain("https://shop.muster.at")).toBe("shop.muster.at")
  })

  it("keeps multi-part public suffixes intact", () => {
    expect(normalizeDomain("https://www.example.co.uk")).toBe("example.co.uk")
  })

  it("rejects values that cannot be a public domain", () => {
    for (const input of ["", "   ", "localhost", "192.168.1.1", "not a domain", "http://", null]) {
      expect(normalizeDomain(input), JSON.stringify(input)).toBeNull()
    }
  })
})

describe("normalizePhone", () => {
  it("converts Austrian national formats to E.164", () => {
    for (const input of [
      "0732 123456",
      "0732/123456",
      "0732-123456",
      "+43 732 123456",
      "0043 732 123456",
      "(0732) 123 456",
    ]) {
      expect(normalizePhone(input), input).toBe("+43732123456")
    }
  })

  it("respects the default country", () => {
    expect(normalizePhone("089 1234567", "DE")).toBe("+49891234567")
    expect(normalizePhone("044 1234567", "CH")).toBe("+41441234567")
  })

  it("leaves an explicit country code alone regardless of the default", () => {
    expect(normalizePhone("+49 89 1234567", "AT")).toBe("+49891234567")
  })

  it("returns null rather than guessing", () => {
    // A wrong number would merge two unrelated companies in the dedupe cascade.
    for (const input of ["123456", "abc", "", "12345678901234567890", null, "555-1234"]) {
      expect(normalizePhone(input), JSON.stringify(input)).toBeNull()
    }
  })
})

describe("normalizeCompanyName", () => {
  it("strips legal forms", () => {
    expect(normalizeCompanyName("Muster Produktion GmbH")).toBe("muster produktion")
    expect(normalizeCompanyName("Muster Produktion GmbH & Co KG")).toBe("muster produktion")
    expect(normalizeCompanyName("Muster Produktion Ges.m.b.H.")).toBe("muster produktion")
    expect(normalizeCompanyName("Muster AG")).toBe("muster")
  })

  it("transliterates umlauts instead of dropping them", () => {
    // "Müller" and "Muller" are different companies; "Müller" and "Mueller" are not.
    expect(normalizeCompanyName("Müller Bau")).toBe("mueller bau")
    expect(normalizeCompanyName("Mueller Bau")).toBe("mueller bau")
    expect(normalizeCompanyName("Gasthaus Zur Schönen Aussicht")).toBe(
      "gasthaus zur schoenen aussicht"
    )
  })

  it("folds other accents onto the base letter", () => {
    expect(normalizeCompanyName("Café Central")).toBe("cafe central")
  })

  it("collapses punctuation and whitespace", () => {
    expect(normalizeCompanyName("  Muster   -  Produktion  ")).toBe("muster produktion")
  })

  it("returns null when nothing distinctive remains", () => {
    for (const input of ["", "   ", "GmbH", "!!!", null]) {
      expect(normalizeCompanyName(input), JSON.stringify(input)).toBeNull()
    }
  })

  it("produces the same key for spellings that mean the same company", () => {
    const variants = [
      "Muster Produktion GmbH",
      "MUSTER PRODUKTION GMBH",
      "Muster Produktion Gesellschaft m.b.H.",
      "  muster produktion  ",
    ]
    const keys = new Set(variants.map((v) => normalizeCompanyName(v)))
    expect(keys.size).toBe(1)
  })
})

describe("normalizeWebsite", () => {
  it("returns a fully qualified URL", () => {
    expect(normalizeWebsite("muster.at")).toBe("https://muster.at")
    expect(normalizeWebsite("www.muster.at")).toBe("https://muster.at")
    expect(normalizeWebsite("https://muster.at/kontakt")).toBe("https://muster.at/kontakt")
  })

  it("drops credentials from a URL", () => {
    expect(normalizeWebsite("https://user:pass@muster.at/x")).toBe("https://muster.at/x")
  })

  it("returns null for unusable input", () => {
    expect(normalizeWebsite("not a url")).toBeNull()
    expect(normalizeWebsite(null)).toBeNull()
  })
})

describe("small normalizers", () => {
  it("normalizes country codes", () => {
    expect(normalizeCountryCode("at")).toBe("AT")
    expect(normalizeCountryCode(" De ")).toBe("DE")
    expect(normalizeCountryCode("AUT")).toBeNull()
    expect(normalizeCountryCode("")).toBeNull()
  })

  it("normalizes postal codes", () => {
    expect(normalizePostalCode("4020")).toBe("4020")
    expect(normalizePostalCode("A-4020")).toBe("A4020")
    expect(normalizePostalCode(" ")).toBeNull()
  })

  it("cleans strings", () => {
    expect(cleanString("  a   b  ")).toBe("a b")
    expect(cleanString("")).toBeNull()
    expect(cleanString(null)).toBeNull()
  })

  it("normalizes emails", () => {
    expect(normalizeEmail("  Office@Muster.AT ")).toBe("office@muster.at")
    expect(normalizeEmail("not-an-email")).toBeNull()
  })
})
