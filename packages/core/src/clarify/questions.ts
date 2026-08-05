import {
  MATCH_ALL,
  categoriesFor,
  type OnboardingProfile,
  type FilterNode,
  type SearchSpec,
  type TargetType,
} from "@alg/shared"

/**
 * Turns a vague request into a runnable search by asking at most four questions.
 *
 * The cap is the design. A user who wanted "Handwerksbetriebe in Oberösterreich"
 * will answer two or three questions; a wizard that asks eleven gets abandoned.
 * So the machine asks only what actually changes the result, and everything else
 * takes a documented default that the preview shows before anything runs.
 *
 * Deliberately rule-based rather than LLM-driven: which questions matter follows
 * from what the spec is missing, and that is knowable. The LLM's place is
 * drafting the rubric (M3), where the answer is genuinely a judgement call.
 */

export const MAX_QUESTIONS = 4

export type QuestionType = "boolean_or_both" | "single_select" | "multi_select" | "range"

export interface ClarifyOption {
  value: string
  /** i18n key; the German string lives in the frontend. */
  labelKey: string
  /** Set on the option the machine takes when the question is skipped. */
  isDefault?: boolean
}

export interface ClarifyQuestion {
  id: string
  type: QuestionType
  /** i18n key for the question text. */
  promptKey: string
  options?: ClarifyOption[]
  /** For range questions. */
  min?: number
  max?: number
  unit?: string
  /**
   * What happens if the user does not answer.
   *
   * Every question has one: a wizard that cannot be skipped is a wizard that
   * gets abandoned halfway, and an unanswered question must still produce a
   * runnable search.
   */
  defaultValue: string | string[] | number | null
  /** Why this is being asked, so the UI can explain itself. */
  reasonKey: string
}

export interface ClarifyAnswer {
  questionId: string
  value: string | string[] | number | boolean | null
}

export interface ClarifyState {
  targetType: TargetType
  /** What the user typed, kept so the questions can be recomputed. */
  description: string
  /** Answers given so far, keyed by question id. */
  answers: Record<string, ClarifyAnswer["value"]>
  spec: SearchSpec
}

/**
 * Works out which questions still matter for this spec.
 *
 * Ordered by how much the answer changes the result, and capped at
 * MAX_QUESTIONS. A question whose answer is already in the spec is not asked
 * again - re-asking is how a wizard loses trust.
 */
export function nextQuestions(state: ClarifyState): ClarifyQuestion[] {
  const questions: ClarifyQuestion[] = []
  const keys = collectKeys(state.spec.filters)
  const answered = new Set(Object.keys(state.answers))

  // 1. Where. Without a geographic constraint Overpass refuses outright and
  //    Places returns the whole world, so this is the one that matters most.
  if (!keys.has("core.geo") && !keys.has("core.city") && !answered.has("region")) {
    questions.push({
      id: "region",
      type: "single_select",
      promptKey: "clarify.region.prompt",
      options: [
        { value: "oberoesterreich", labelKey: "clarify.region.oberoesterreich", isDefault: true },
        { value: "niederoesterreich", labelKey: "clarify.region.niederoesterreich" },
        { value: "salzburg", labelKey: "clarify.region.salzburg" },
        { value: "steiermark", labelKey: "clarify.region.steiermark" },
        { value: "tirol", labelKey: "clarify.region.tirol" },
        { value: "vorarlberg", labelKey: "clarify.region.vorarlberg" },
        { value: "kaernten", labelKey: "clarify.region.kaernten" },
        { value: "burgenland", labelKey: "clarify.region.burgenland" },
        { value: "wien", labelKey: "clarify.region.wien" },
        { value: "austria", labelKey: "clarify.region.austria" },
      ],
      defaultValue: "oberoesterreich",
      reasonKey: "clarify.region.reason",
    })
  }

  // 2. What kind of business. Without it the search returns every mapped
  //    company in the area, which is rarely what anyone meant.
  if (!keys.has("core.category") && !answered.has("category")) {
    questions.push({
      id: "category",
      type: "multi_select",
      promptKey: "clarify.category.prompt",
      options: categoriesFor(state.targetType).map((category) => ({
        value: category.slug,
        labelKey: category.labelKey,
      })),
      // No default: guessing an industry would silently narrow the search to
      // something the user never said.
      defaultValue: null,
      reasonKey: "clarify.category.reason",
    })
  }

  // 3. Website or not. The single most common qualifier, and the one that
  //    decides whether the crawl runs at all - so it is worth an explicit ask
  //    rather than a default that quietly costs a provider run per company.
  if (!keys.has("web.presence.has_website") && !answered.has("website")) {
    questions.push({
      id: "website",
      type: "boolean_or_both",
      promptKey: "clarify.website.prompt",
      options: [
        { value: "without", labelKey: "clarify.website.without" },
        { value: "with", labelKey: "clarify.website.with" },
        { value: "both", labelKey: "clarify.website.both", isDefault: true },
      ],
      // "both" adds no filter, so the website providers stay unreferenced and
      // the search costs nothing extra.
      defaultValue: "both",
      reasonKey: "clarify.website.reason",
    })
  }

  // 4. How many. Last because it never changes which leads are found, only how
  //    many are fetched - and it has a sane default.
  if (state.spec.limit === undefined && !answered.has("limit")) {
    questions.push({
      id: "limit",
      type: "range",
      promptKey: "clarify.limit.prompt",
      min: 10,
      max: 5000,
      unit: "leads",
      defaultValue: 500,
      reasonKey: "clarify.limit.reason",
    })
  }

  return questions.slice(0, MAX_QUESTIONS)
}

/**
 * Folds an answer into the spec.
 *
 * Returns a new state rather than mutating: the caller stores it, and a
 * half-applied answer after a validation failure would leave a spec nobody
 * chose.
 */
export function applyAnswer(state: ClarifyState, answer: ClarifyAnswer): ClarifyState {
  const answers = { ...state.answers, [answer.questionId]: answer.value }
  let spec = state.spec

  switch (answer.questionId) {
    case "region": {
      const area = REGION_BBOX[String(answer.value)]
      if (area) {
        spec = withFilterReplacing(spec, ["core.geo"], {
          op: "within",
          key: "core.geo",
          value: { bbox: area },
        })
      }
      break
    }
    case "category": {
      const values = Array.isArray(answer.value)
        ? answer.value.map(String)
        : answer.value
          ? [String(answer.value)]
          : []
      if (values.length === 1) {
        spec = withFilterReplacing(spec, ["core.category", "core.name"], {
          op: "eq",
          key: "core.category",
          value: values[0],
        })
      } else if (values.length > 1) {
        spec = withFilterReplacing(spec, ["core.category", "core.name"], {
          op: "in",
          key: "core.category",
          value: values,
        })
      }
      break
    }
    case "website": {
      // "both" deliberately adds nothing: referencing the signal is what makes
      // the crawler run, so a no-op answer must stay a no-op.
      if (answer.value === "without") {
        spec = withFilter(spec, { op: "eq", key: "web.presence.has_website", value: false })
      } else if (answer.value === "with") {
        spec = withFilter(spec, { op: "eq", key: "web.presence.has_website", value: true })
      }
      break
    }
    case "limit": {
      const limit = Number(answer.value)
      if (Number.isInteger(limit) && limit > 0) {
        spec = { ...spec, limit }
      }
      break
    }
    default:
      // An unknown question id is recorded but changes nothing. The frontend may
      // be a version ahead; dropping the answer is better than throwing.
      break
  }

  return { ...state, answers, spec }
}

/**
 * Applies the default for every unanswered question.
 *
 * This is what makes the wizard skippable: the user presses "run" at any point
 * and gets a search built from documented defaults rather than an error.
 */
export function applyDefaults(state: ClarifyState): ClarifyState {
  let current = state

  for (const question of nextQuestions(state)) {
    if (question.defaultValue === null) continue
    current = applyAnswer(current, {
      questionId: question.id,
      value: question.defaultValue,
    })
  }

  return current
}

/** True when the spec can run: it has a geographic constraint. */
export function isRunnable(spec: SearchSpec): boolean {
  const keys = collectKeys(spec.filters)
  return keys.has("core.geo") || keys.has("core.city") || keys.has("core.postal_code")
}

/** Rough bounding boxes per Austrian state: [south, west, north, east]. */
const REGION_BBOX: Record<string, [number, number, number, number]> = {
  oberoesterreich: [47.42, 12.75, 48.78, 15.0],
  niederoesterreich: [47.42, 14.44, 49.02, 17.07],
  salzburg: [46.94, 12.07, 48.08, 13.99],
  steiermark: [46.62, 13.56, 47.84, 16.18],
  tirol: [46.65, 10.1, 47.75, 12.98],
  vorarlberg: [46.84, 9.53, 47.6, 10.24],
  kaernten: [46.37, 12.66, 47.16, 15.07],
  burgenland: [46.84, 16.09, 48.13, 17.16],
  wien: [48.11, 16.18, 48.33, 16.58],
  /**
   * Ganz Oesterreich ist eine legitime Wahl, aber eine teure.
   *
   * Gemessen: eine Kategorie-Abfrage ueber diese Flaeche (20.2 Quadratgrad)
   * braucht auf Overpass rund 47s und scheitert unter Last; dasselbe fuer Wien
   * (0.09) kommt in 4s zurueck. Wer das Land waehlt, soll es bekommen - aber
   * die Rueckfrage nennt zuerst die Bundeslaender.
   */
  austria: [46.37, 9.53, 49.02, 17.16],
}

/** Adds a leaf to the spec's top-level AND, creating one if needed. */
/**
 * Entfernt jede Bedingung auf den genannten Schluesseln, beliebig tief.
 *
 * Noetig, weil drei Quellen nacheinander in dieselbe Spec schreiben: das
 * Onboarding-Profil, die Interpretation des Suchtexts und die expliziten
 * Antworten. Ohne das Ersetzen stapelten sie sich - eine echte Spec aus der
 * Produktion enthielt die bbox von ganz Oesterreich UND die von
 * Oberoesterreich, alle 22 Kategorien UND zweimal "restaurant", alles ge-ANDet.
 * Sobald sich zwei Schichten widersprechen, ist so eine Suche leer oder falsch.
 *
 * Wer spaeter schreibt, meint es aktueller: die Antwort ersetzt die
 * Interpretation, die Interpretation ersetzt das Profil.
 */
function stripKeys(node: FilterNode, keys: ReadonlySet<string>): FilterNode | null {
  if (node.op === "and" || node.op === "or") {
    const children = node.children
      .map((child) => stripKeys(child, keys))
      .filter((child): child is FilterNode => child !== null)
    if (children.length === 0) return null
    if (children.length === 1 && node.op === "and") return children[0] ?? null
    return { ...node, children }
  }
  if (node.op === "not") {
    const child = stripKeys(node.child, keys)
    return child === null ? null : { ...node, child }
  }
  return "key" in node && keys.has(node.key) ? null : node
}

/** withFilter, aber vorher raeumen: eine Bedingung pro Schluessel. */
function withFilterReplacing(
  spec: SearchSpec,
  keys: readonly string[],
  leaf: FilterNode
): SearchSpec {
  const stripped = stripKeys(spec.filters, new Set(keys))
  const base: SearchSpec = { ...spec, filters: stripped ?? MATCH_ALL }
  return withFilter(base, leaf)
}

function withFilter(spec: SearchSpec, leaf: FilterNode): SearchSpec {
  const filters = spec.filters

  if (filters.op === "and" && "children" in filters) {
    return { ...spec, filters: { op: "and", children: [...filters.children, leaf] } }
  }

  // Anything else becomes the first child of a new AND, so an existing OR or
  // NOT keeps its meaning instead of being flattened away.
  const existing = isMatchAll(filters) ? [] : [filters]
  return { ...spec, filters: { op: "and", children: [...existing, leaf] } }
}

function isMatchAll(node: FilterNode): boolean {
  return node.op === "and" && "children" in node && node.children.length === 0
}

function collectKeys(node: FilterNode): Set<string> {
  const keys = new Set<string>()

  const walk = (current: FilterNode): void => {
    if ("children" in current) {
      current.children.forEach(walk)
    } else if ("child" in current) {
      walk(current.child)
    } else if ("key" in current) {
      keys.add(current.key)
    }
  }

  walk(node)
  return keys
}

/** Die Regionen, die eine Suche kennt - fuer den Suchtext-Parser. */
export const KNOWN_REGIONS: string[] = Object.keys(REGION_BBOX)

/**
 * Uebernimmt, was aus dem Suchtext gelesen wurde.
 *
 * Vorher landete die Beschreibung in einem Feld und wurde nie wieder gelesen:
 * wer "Baufirmen in Linz" eintippte, wurde anschliessend gefragt, in welcher
 * Region er suchen wolle. Das wirkte, als haette niemand zugehoert.
 *
 * Der Ort ist genauer als die Region und kommt zusaetzlich dazu - "Linz"
 * heisst Oberoesterreich *und* core.city=Linz, sonst waere das halbe
 * Bundesland im Ergebnis.
 */
export function applyInterpretation(
  state: ClarifyState,
  interpreted: {
    region: string | null
    city: string | null
    categories: string[]
    tradeTerm?: string | null
    limit: number | null
  }
): ClarifyState {
  let current = state

  if (interpreted.region) {
    current = applyAnswer(current, { questionId: "region", value: interpreted.region })
  }
  if (interpreted.categories.length > 0) {
    current = applyAnswer(current, { questionId: "category", value: interpreted.categories })
  } else if (interpreted.tradeTerm) {
    /**
     * Keine passende Kategorie: dann wenigstens nach dem Wort im Namen suchen.
     *
     * "Elektroniker" bildet auf keinen Slug ab. Die Branche ersatzlos
     * fallenzulassen machte aus der Suche eine Rundumsuche - ein Arzt, zwei
     * Supermaerkte und zwei Lokale als Antwort auf "Elektroniker in Linz".
     *
     * Ein Namensfilter ist gröber als eine Kategorie und findet den Betrieb
     * nicht, der sich anders nennt. Aber er beantwortet die gestellte Frage,
     * statt eine andere.
     */
    current = {
      ...current,
      spec: withFilterReplacing(current.spec, ["core.name"], {
        op: "contains",
        key: "core.name",
        value: interpreted.tradeTerm,
      }),
    }
  }
  if (interpreted.limit) {
    current = applyAnswer(current, { questionId: "limit", value: interpreted.limit })
  }
  if (interpreted.city) {
    // Eine Ziffernfolge ist eine PLZ. Als Ortsname gesucht faende sie nichts.
    const leaf = /^\d{4,5}$/.test(interpreted.city)
      ? { op: "eq" as const, key: "core.postal_code", value: interpreted.city }
      : { op: "contains" as const, key: "core.city", value: interpreted.city }
    current = {
      ...current,
      spec: withFilterReplacing(current.spec, ["core.city", "core.postal_code"], leaf),
    }
  }

  return current
}

/** A fresh state for a description the user typed. */
export function startClarification(
  description: string,
  targetType?: TargetType | null,
  profile?: OnboardingProfile | null
): ClarifyState {
  /**
   * Der Zieltyp aus der Anfrage gewinnt, das Profil fuellt nur die Luecke.
   *
   * Vorher war es umgekehrt: `profile?.target?.targetType ?? targetType`
   * ueberschrieb genau das, was der Nutzer gerade im Umschalter angeklickt
   * hatte. Stand im Onboarding "list", wurde jede Suche zu einer Listensuche -
   * und weil fuer `list` kein Provider Signale liefert, scheiterte zuerst der
   * Rubrikentwurf ("no signals available for this target type") und danach die
   * Anreicherung. Aus "Autohaus in Linz" wurden zwei Fehlermeldungen.
   *
   * Ein Profil ist eine Voreinstellung, keine Vorschrift.
   */
  const fromProfile = profile?.target?.targetType

  /**
   * Ein Profil darf keinen Zieltyp vorgeben, fuer den nichts funktioniert.
   *
   * `list` entsteht nur durch CSV-Import: keine Quelle sucht danach, kein
   * Provider liefert Signale dafuer. Als gespeicherte Voreinstellung machte er
   * jede Suche unbrauchbar - "no signals available for this target type" beim
   * Rubrikentwurf, danach dasselbe bei der Anreicherung. Ein Wert, der einmal
   * in der Datenbank steht, bleibt dort, bis ihn jemand ueberschreibt; deshalb
   * wird er hier abgefangen statt nur im Formular.
   */
  const usableFromProfile = fromProfile === "list" ? undefined : fromProfile

  const resolvedType: TargetType = targetType ?? usableFromProfile ?? "company"

  const state: ClarifyState = {
    targetType: resolvedType,
    description,
    answers: {},
    spec: { targetType: resolvedType, filters: MATCH_ALL },
  }

  return profile ? applyProfile(state, profile) : state
}

/**
 * Folds what onboarding learned into a fresh search.
 *
 * This is what makes the wizard worth filling in: someone who said
 * "Oberösterreich, Handwerksbetriebe" gets asked neither again. The answers are
 * applied exactly as if the user had just given them, so nextQuestions() drops
 * them on its own - there is no second code path deciding what to skip.
 *
 * Only region and categories carry over. The website question and the limit are
 * per-search decisions: wanting leads without a website today says nothing about
 * tomorrow, and a stored limit would silently cap searches the user did not
 * mean to cap.
 */
export function applyProfile(state: ClarifyState, profile: OnboardingProfile): ClarifyState {
  let current = state

  const region = profile.target?.region
  if (region) {
    current = applyAnswer(current, { questionId: "region", value: region })
  }

  const categories = profile.target?.categories
  if (categories && categories.length > 0) {
    current = applyAnswer(current, { questionId: "category", value: categories })
  }

  return current
}
