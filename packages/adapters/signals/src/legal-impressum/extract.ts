/**
 * Extracts contact and legal data from an Impressum page.
 *
 * Austrian and German sites are legally required to carry one (ECG §5, DDG §5),
 * which makes it the most reliable contact source on a company website - far
 * better than guessing info@domain.
 *
 * Deliberately regex-based rather than DOM-parsing: the target data is short,
 * well-signposted by German legal vocabulary, and the pages vary wildly in
 * markup. A parser would add a dependency without improving the hit rate.
 */

/** Paths worth trying, in the order they are most likely to exist. */
export const IMPRESSUM_PATHS = [
  "/impressum",
  "/impressum/",
  "/imprint",
  "/de/impressum",
  "/kontakt",
  "/legal",
  "/impressum.html",
  "/impressum.php",
]

export interface ImpressumData {
  email: string | null
  phone: string | null
  /** Firmenbuchnummer, e.g. "FN 123456a". */
  companyRegisterNumber: string | null
  /** UID / VAT id, e.g. "ATU12345678". */
  vatId: string | null
  /** Named managing directors. */
  managingDirectors: string[]
  /** True when the page looks like a real Impressum rather than a random page. */
  looksLikeImpressum: boolean
}

/**
 * Named entities that actually occur in German address and company data. German
 * pages routinely write umlauts this way, and missing them would break both the
 * street name and the Impressum marker detection.
 */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  szlig: "ß",
  auml: "ä",
  ouml: "ö",
  uuml: "ü",
  Auml: "Ä",
  Ouml: "Ö",
  Uuml: "Ü",
  eacute: "é",
  egrave: "è",
  agrave: "à",
  ccedil: "ç",
  sect: "§",
  euro: "€",
  copy: "©",
  ndash: "-",
  mdash: "-",
  hellip: "...",
}

/** Strips tags and decodes the entities that actually appear in contact data. */
export function htmlToText(html: string): string {
  return (
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      // Named entities are case-sensitive: &Ouml; and &ouml; are different letters.
      .replace(/&([a-zA-Z]+);/g, (match, name: string) => NAMED_ENTITIES[name] ?? match)
      .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
      .replace(/[ \t]+/g, " ")
      // Collapse whitespace around newlines too - "</p> <p>" leaves a space that
      // would otherwise survive as "Zeile 1\n Zeile 2".
      .replace(/[ \t]*\n[ \t\n]*/g, "\n")
      .trim()
  )
}

const IMPRESSUM_MARKERS = [
  "impressum",
  "offenlegung",
  "firmenbuch",
  "medieninhaber",
  "angaben gemäß",
  "angaben gemaess",
  "diensteanbieter",
  "verantwortlich für den inhalt",
  "ecg",
]

/**
 * Emails are also collected from mailto: links, because sites frequently obfuscate
 * the visible text while leaving the href intact.
 */
function extractEmails(html: string, text: string): string[] {
  const found = new Set<string>()

  for (const match of html.matchAll(/mailto:([^"'?>\s]+)/gi)) {
    const value = match[1]?.trim().toLowerCase()
    if (value) found.add(decodeURIComponent(value))
  }

  for (const match of text.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)) {
    found.add(match[0].toLowerCase())
  }

  // A common obfuscation: "office (at) muster.at"
  for (const match of text.matchAll(/([\w.+-]+)\s*[([{]\s*at\s*[)\]}]\s*([\w.-]+\.[a-z]{2,})/gi)) {
    if (match[1] && match[2]) found.add(`${match[1]}@${match[2]}`.toLowerCase())
  }

  return [...found].filter(isPlausibleEmail)
}

function isPlausibleEmail(email: string): boolean {
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) return false
  // Image filenames and tracking pixels routinely look like addresses.
  if (/\.(png|jpe?g|gif|svg|webp|css|js)$/i.test(email)) return false
  if (email.includes("..")) return false
  return true
}

/**
 * Ranks candidates so a real contact address beats a webmaster or privacy one.
 * The first is what an outreach message should go to.
 */
function pickBestEmail(emails: string[], domain: string | null): string | null {
  if (emails.length === 0) return null

  const score = (email: string): number => {
    let value = 0
    const local = email.split("@")[0] ?? ""
    const host = email.split("@")[1] ?? ""

    // Same domain as the website is a strong signal it is the company's own.
    if (domain && host.endsWith(domain)) value += 10
    if (/^(office|kontakt|contact|info|mail|hello)$/i.test(local)) value += 5
    if (/^(datenschutz|privacy|dsgvo|gdpr|abuse|postmaster|webmaster|noreply)/i.test(local)) {
      value -= 10
    }
    // Agency addresses in the footer are not the company's own.
    if (/(wordpress|wix|jimdo|hosting|webdesign)/i.test(host)) value -= 5

    return value
  }

  return [...emails].sort((a, b) => score(b) - score(a))[0] ?? null
}

function extractPhone(text: string): string | null {
  // Anchored on the usual German labels: an unlabelled number in the page body
  // is as likely to be a street number or a price.
  const labelled = text.match(
    /(?:tel(?:efon)?|phone|fon|mobil|t)\s*[.:]?\s*((?:\+|00)?[\d\s()/.-]{7,25})/i
  )
  if (labelled?.[1]) {
    const cleaned = labelled[1].replace(/[^\d+]/g, "")
    if (cleaned.replace(/\D/g, "").length >= 7) return labelled[1].trim()
  }

  const international = text.match(/\+\d{1,3}[\s()/.-]?\d[\d\s()/.-]{6,20}/)
  return international?.[0]?.trim() ?? null
}

export function extractImpressum(html: string, domain: string | null = null): ImpressumData {
  const text = htmlToText(html)
  const lower = text.toLowerCase()

  const looksLikeImpressum = IMPRESSUM_MARKERS.some((marker) => lower.includes(marker))

  const emails = extractEmails(html, text)

  // "FN 123456a" or "FN123456 a" - the letter is a check character.
  const fn = text.match(/\bFN\s*(\d{1,6}\s?[a-z])\b/i)
  // Austrian UID, German USt-IdNr and the generic EU form.
  const vat = text.match(/\b(ATU\d{8}|DE\d{9}|[A-Z]{2}\s?\d{8,12})\b/)

  const directors: string[] = []
  for (const match of text.matchAll(
    /(?:gesch[äa]ftsf[üu]hrer(?:in)?|inhaber(?:in)?|vertreten durch)\s*[:.]?\s*([^\n]{3,80})/gi
  )) {
    const value = match[1]?.trim()
    if (value) directors.push(value.replace(/\s{2,}/g, " "))
  }

  return {
    email: pickBestEmail(emails, domain),
    phone: extractPhone(text),
    companyRegisterNumber: fn?.[1] ? `FN ${fn[1].replace(/\s+/g, "")}` : null,
    vatId: vat?.[1]?.replace(/\s+/g, "") ?? null,
    managingDirectors: directors.slice(0, 3),
    looksLikeImpressum,
  }
}

/** Finds Impressum links in a page, for sites that use an unusual path. */
export function findImpressumLinks(html: string, baseUrl: string): string[] {
  const links = new Set<string>()

  for (const match of html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi)) {
    const href = match[1]
    const label = (match[2] ?? "").toLowerCase()
    if (!href) continue

    if (/impressum|imprint|kontakt|legal|offenlegung/.test(label + " " + href.toLowerCase())) {
      try {
        const resolved = new URL(href, baseUrl)
        if (resolved.protocol === "http:" || resolved.protocol === "https:") {
          links.add(resolved.toString())
        }
      } catch {
        // A malformed href is not worth failing the extraction over.
      }
    }
  }

  return [...links].slice(0, 5)
}
