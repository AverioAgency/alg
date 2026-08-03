/**
 * Normalization rules that feed the dedupe cascade.
 *
 * Every stage of the cascade compares normalized values, so these functions define
 * what "the same company" means in practice. They are deliberately conservative:
 * a false merge silently destroys a lead, while a missed merge only costs a
 * duplicate row that a later pass can still catch.
 */

/** Suffixes that carry no identity. Order matters - longest match wins. */
const LEGAL_FORMS = [
  "gesellschaft mit beschraenkter haftung",
  "gesellschaft m.b.h.",
  "ges.m.b.h.",
  "gmbh & co kg",
  "gmbh & co. kg",
  "ag & co kg",
  "e.u.",
  "gmbh",
  "gesmbh",
  "mbh",
  "og",
  "kg",
  "ag",
  "se",
  "ug",
  "eu",
  "kft",
  "s.r.o.",
  "z.o.o.",
  "ltd",
  "limited",
  "inc",
  "llc",
  "bv",
  "nv",
  "sa",
  "srl",
  "spa",
]

/**
 * Reduces a URL or bare hostname to a registrable domain: lowercase, no scheme,
 * no www, no port, no path. Returns null for anything that is not a usable host.
 */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null

  let value = input.trim().toLowerCase()
  if (value.length === 0) return null

  // Tolerate bare hostnames as well as full URLs.
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(value)) {
    value = `http://${value}`
  }

  let host: string
  try {
    host = new URL(value).hostname
  } catch {
    return null
  }

  host = host.replace(/^www\./, "").replace(/\.$/, "")

  // Reject things that cannot be a public domain.
  if (!host.includes(".")) return null
  if (/^\d+(\.\d+)*$/.test(host)) return null
  if (!/^[a-z0-9.-]+$/.test(host)) return null
  if (host.startsWith("-") || host.endsWith("-")) return null

  return host
}

/**
 * Normalizes a phone number to E.164. `defaultCountry` supplies the calling code
 * for national-format input; AT is the common case for this project.
 *
 * This is a pragmatic subset, not a full libphonenumber: it handles the formats
 * the discovery sources actually emit. Numbers it cannot confidently normalize
 * return null rather than a guess, because a wrong number merges two companies.
 */
export function normalizePhone(
  input: string | null | undefined,
  defaultCountry: "AT" | "DE" | "CH" = "AT"
): string | null {
  if (!input) return null

  const CALLING_CODES = { AT: "43", DE: "49", CH: "41" } as const

  // Keep digits and a leading +; discard spaces, slashes, dashes, parentheses and
  // extension markers, which sources use inconsistently.
  let value = input.trim().replace(/[^\d+]/g, "")
  if (value.length === 0) return null

  if (value.startsWith("00")) {
    value = `+${value.slice(2)}`
  } else if (value.startsWith("0")) {
    value = `+${CALLING_CODES[defaultCountry]}${value.slice(1)}`
  } else if (!value.startsWith("+")) {
    // No country code and no trunk prefix: too ambiguous to place.
    return null
  }

  const digits = value.slice(1)
  if (!/^\d+$/.test(digits)) return null
  // E.164 allows at most 15 digits; anything shorter than 7 is not a real number.
  if (digits.length < 7 || digits.length > 15) return null

  return `+${digits}`
}

/**
 * Strips accents, legal forms and punctuation so trigram similarity compares the
 * distinctive part of a name. "Muster Produktion GmbH & Co KG" -> "muster produktion".
 */
export function normalizeCompanyName(input: string | null | undefined): string | null {
  if (!input) return null

  // German umlauts must transliterate (ü -> ue) BEFORE accent stripping, which
  // would otherwise decompose them to a bare u and lose the distinction.
  let value = input
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")

  // Remaining accents (café, señor) fold onto their base letter.
  value = value.normalize("NFD").replace(/\p{Diacritic}/gu, "")

  value = value
    .replace(/[^a-z0-9\s.&-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()

  // Remove legal forms wherever they appear, not just as a suffix: sources write
  // "GmbH Muster" and "Muster GmbH Zweigstelle" alike.
  for (const form of LEGAL_FORMS) {
    const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    value = value.replace(new RegExp(`(^|\\s)${escaped}(\\s|$)`, "g"), " ")
  }

  value = value.replace(/[.&-]/g, " ").replace(/\s+/g, " ").trim()

  return value.length > 0 ? value : null
}

/** Uppercased ISO 3166-1 alpha-2, or null. */
export function normalizeCountryCode(input: string | null | undefined): string | null {
  if (!input) return null
  const value = input.trim().toUpperCase()
  return /^[A-Z]{2}$/.test(value) ? value : null
}

/** Postal codes are compared as digits/letters only, without separators. */
export function normalizePostalCode(input: string | null | undefined): string | null {
  if (!input) return null
  const value = input
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
  return value.length > 0 ? value : null
}

/** Trims and collapses whitespace; returns null for empty strings. */
export function cleanString(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null
  const value = String(input).replace(/\s+/g, " ").trim()
  return value.length > 0 ? value : null
}

/** Basic shape check. Deliverability is verified later, in the signal layer. */
export function normalizeEmail(input: string | null | undefined): string | null {
  if (!input) return null
  const value = input.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null
  return value
}

/** Ensures a website is a fully qualified http(s) URL, or null. */
export function normalizeWebsite(input: string | null | undefined): string | null {
  if (!input) return null
  const domain = normalizeDomain(input)
  if (!domain) return null

  const trimmed = input.trim()
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed)
      // Rebuild from parsed parts so credentials and fragments do not survive.
      return `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname}`
    } catch {
      return `https://${domain}`
    }
  }
  return `https://${domain}`
}
