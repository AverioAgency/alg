import {
  type CategoryDef,
  type OnboardingProfile,
  type TargetType,
} from "@alg/shared"
import { LlmResponseError, type LlmClient } from "../scoring/llm-client.js"

/**
 * Liest einen frei formulierten Suchauftrag und macht daraus Suchparameter.
 *
 * "Baufirmen in Linz mit unter 50 Mitarbeitern" enthält drei Angaben: eine
 * Branche, einen Ort und eine Größenangabe. Die Rückfrage-Maschine allein sieht
 * davon nichts - sie hat den Text nur gespeichert und anschließend nach Region
 * und Branche gefragt, die längst dastanden. Das wirkte, als hätte niemand
 * zugehört.
 *
 * Was hier herauskommt, sind nur die Angaben, die eine Suche steuern können:
 * Ort, Branche, Zielart. Die Mitarbeiterzahl kann keine Quelle liefern - sie
 * geht deshalb nicht verloren, sondern als `forRubric` weiter, wo die
 * LLM-Stufe sie beim Bewerten jedes Leads prüft. Sie stillschweigend
 * fallenzulassen wäre der schlimmere Weg: der Nutzer hat sie genannt und würde
 * annehmen, sie sei berücksichtigt.
 */

export interface InterpretSearchOptions {
  client: LlmClient
  /** Was der Nutzer getippt hat. */
  description: string
  /** Erlaubte Branchen - der Katalog, gegen den das Modell abbilden muss. */
  categories: readonly CategoryDef[]
  /** Bekannte Regionen (Schlüssel aus REGION_BBOX). */
  regions: readonly string[]
  /** Kontext: wer sucht und was verkauft er. Schärft die Auslegung. */
  profile?: OnboardingProfile | null
  signal?: AbortSignal
}

export interface InterpretedSearch {
  /** Regionsschlüssel, oder null wenn keiner genannt war. */
  region: string | null
  /** Ort oder PLZ, falls feiner als eine Region ("Linz", "4020"). */
  city: string | null
  /** Branchen-Slugs aus dem Katalog. Leer heißt "keine Einschränkung". */
  categories: string[]
  targetType: TargetType | null
  /** Obergrenze, falls der Text eine nennt ("die besten 20"). */
  limit: number | null
  /**
   * Wünsche, die keine Quelle filtern kann - Mitarbeiterzahl, Umsatz,
   * "expandiert gerade". Gehen als LLM-Kriterium in die Rubrik.
   */
  forRubric: string[]
  /**
   * Branchenwort für die Namenssuche, wenn keine Kategorie passt.
   *
   * "Elektroniker" bildet auf keinen Slug ab. Ohne dieses Feld fiel die Branche
   * ersatzlos weg und die Abfrage wurde zur Rundumsuche: ein Arzt, zwei
   * Supermärkte und zwei Lokale als Antwort auf "Elektroniker in Linz".
   */
  tradeTerm: string | null
  /** Was das Modell aus dem Text gelesen hat, in einem Satz. Für die Anzeige. */
  summary: string
}

const SYSTEM_PROMPT = [
  "Du übersetzt einen frei formulierten Suchauftrag in Suchparameter für eine",
  "Firmendatenbank.",
  "",
  "Harte Regeln:",
  "- Branchen ausschließlich als Slugs aus der übergebenen Liste. Wähle den",
  "  nächstliegenden, auch wenn er weiter gefasst ist: ein Elektriker ist ein",
  "  craft_business, ein Baumeister auch. Ein erfundener Slug findet nichts.",
  "- Passt wirklich kein Slug, gehört die Branche nach trade_term - dem Wort,",
  "  das im Firmennamen stehen dürfte ('Elektro', 'Bau'). Sie einfach",
  "  wegzulassen macht aus einer Branchensuche eine Suche nach allem, was es",
  "  im Gebiet gibt - das ist nie die gestellte Frage.",
  "- Region nur, wenn der Text eine nennt oder eindeutig impliziert. Eine Stadt",
  "  gehört zusätzlich nach city: 'Linz' ist oberoesterreich UND city=Linz.",
  "- Rate nichts hinzu. Steht keine Region im Text, ist region null - eine",
  "  erfundene Einschränkung ist schlimmer als eine fehlende.",
  "- Alles, was keine Firmendatenbank filtern kann (Mitarbeiterzahl, Umsatz,",
  "  Gründungsjahr, 'wächst gerade', 'hat kürzlich investiert'), gehört nach",
  "  for_rubric - als kurze, prüfbare Aussage über die Firma.",
  "- summary in einem deutschen Satz: was gesucht wird. Der Nutzer soll sofort",
  "  erkennen, ob du ihn richtig verstanden hast.",
].join("\n")

const SCHEMA_BASE = {
  type: "object",
  properties: {
    city: {
      type: ["string", "null"],
      description: "Ort oder PLZ, falls genannt. Sonst null.",
    },
    limit: {
      type: ["integer", "null"],
      description: "Obergrenze, falls der Text eine nennt. Sonst null.",
    },
    for_rubric: {
      type: "array",
      items: { type: "string" },
      description:
        "Wünsche, die keine Quelle filtern kann - je eine kurze, prüfbare Aussage.",
    },
    trade_term: {
      type: ["string", "null"],
      description:
        "Das Branchenwort für die Namenssuche, wenn kein Slug passt ('Elektro', 'Bau'). Sonst null.",
    },
    summary: { type: "string" },
  },
  required: ["categories", "region", "city", "for_rubric", "summary"],
  additionalProperties: false,
}

function buildSchema(
  categories: readonly CategoryDef[],
  regions: readonly string[]
): Record<string, unknown> {
  return {
    ...SCHEMA_BASE,
    properties: {
      ...SCHEMA_BASE.properties,
      // Als enum, nicht als freier String: so kann das Modell keinen Slug
      // erfinden, den anschliessend kein Adapter kennt.
      categories: {
        type: "array",
        items: { type: "string", enum: categories.map((category) => category.slug) },
      },
      region: { type: ["string", "null"], enum: [...regions, null] },
      target_type: {
        type: ["string", "null"],
        enum: ["local_business", "company", "person", null],
      },
    },
  }
}

function buildUserPrompt(options: InterpretSearchOptions): string {
  const lines = [`Suchauftrag: ${options.description}`, ""]

  const company = options.profile?.company
  const offer = options.profile?.offer?.description

  if (company?.industry || offer) {
    // Kontext hilft bei der Auslegung: "Betriebe die uns brauchen koennten"
    // heisst fuer eine Webagentur etwas anderes als fuer einen Grosshaendler.
    lines.push("Kontext - wer sucht:")
    if (company?.name) lines.push(`- Firma: ${company.name}`)
    if (company?.industry) lines.push(`- Branche: ${company.industry}`)
    if (offer) lines.push(`- Angebot: ${offer}`)
    lines.push("")
  }

  lines.push("Verfügbare Branchen (Slug = Bedeutung):")
  for (const category of options.categories) {
    lines.push(`- ${category.slug}`)
  }

  return lines.join("\n")
}

export async function interpretSearch(
  options: InterpretSearchOptions
): Promise<InterpretedSearch> {
  const response = await options.client.completeJson({
    // "smart": einmal pro Sucheingabe, nicht pro Lead - hier zaehlt Genauigkeit
    // mehr als der Preis. Ein falsch gelesener Auftrag kostet einen ganzen Lauf.
    tier: "smart",
    system: SYSTEM_PROMPT,
    prompt: buildUserPrompt(options),
    schema: buildSchema(options.categories, options.regions),
    maxTokens: 1024,
    ...(options.signal ? { signal: options.signal } : {}),
  })

  const raw = response.value
  if (typeof raw !== "object" || raw === null) {
    throw new LlmResponseError("Das Modell lieferte kein Objekt.")
  }

  /**
   * Der einzige Cast hier, und er ist eng: nach der Pruefung oben ist `raw` ein
   * Objekt, aber TypeScript kennt seine Schluessel nicht - die kommen aus dem
   * JSON-Schema, das die API durchsetzt. Jeder Zugriff darunter prueft den Typ
   * selbst nach, der Cast erlaubt nur den Zugriff, nicht das Vertrauen.
   */
  // eslint-disable-next-line no-restricted-syntax -- siehe Kommentar
  const record = raw as Record<string, unknown>
  const allowedSlugs = new Set(options.categories.map((category) => category.slug))

  /**
   * Nachprüfen, was das Schema schon verlangt hat.
   *
   * Ein `enum` im Schema ist eine Bitte, keine Garantie - die API erzwingt die
   * Struktur, nicht jeden Wertebereich. Ein durchgerutschter Slug würde still
   * zu null Treffern führen, und genau diese Sorte Fehler hat hier schon zu
   * viel Zeit gekostet.
   */
  const categories = Array.isArray(record["categories"])
    ? record["categories"].filter(
        (value): value is string => typeof value === "string" && allowedSlugs.has(value)
      )
    : []

  const region =
    typeof record["region"] === "string" && options.regions.includes(record["region"])
      ? record["region"]
      : null

  const targetType = record["target_type"]

  return {
    region,
    city: typeof record["city"] === "string" && record["city"].length > 0 ? record["city"] : null,
    categories,
    targetType:
      targetType === "local_business" || targetType === "company" || targetType === "person"
        ? targetType
        : null,
    limit:
      typeof record["limit"] === "number" && Number.isInteger(record["limit"]) && record["limit"] > 0
        ? Math.min(record["limit"], 5000)
        : null,
    tradeTerm:
      typeof record["trade_term"] === "string" && record["trade_term"].length > 0
        ? record["trade_term"]
        : null,
    forRubric: Array.isArray(record["for_rubric"])
      ? record["for_rubric"].filter(
          (value): value is string => typeof value === "string" && value.length > 0
        )
      : [],
    summary: typeof record["summary"] === "string" ? record["summary"] : "",
  }
}
