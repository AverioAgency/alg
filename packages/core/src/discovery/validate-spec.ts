import {
  CORE_FIELD_KEYS,
  isBranchNode,
  isLeafNode,
  isNotNode,
  type FilterNode,
} from "@alg/shared"
import { type SignalRegistry } from "../signals/registry.js"

/**
 * Prueft, ob jeder Filterschluessel einer Suche ueberhaupt existiert.
 *
 * Ein erfundener Schluessel ist der teuerste stille Fehler im System. Er faellt
 * nirgends auf: das Zod-Schema laesst `key` bewusst frei (`@alg/shared` kennt
 * die Signal-Registry nicht, sie ist frontend-sicher), kein Adapter kann ihn
 * bedienen, also landet er im Nachfilter - und dort bewertet ein fehlender Wert
 * jeden Treffer als "passt nicht". Ergebnis: `found: 0` ohne Fehlermeldung,
 * nicht zu unterscheiden von einer leeren Gegend.
 *
 * Real passiert mit einer Sidebar, die `geo.state`, `geo.city`, `industry`,
 * `gmb.rating` und `gmb.reviews_count` schickte - fuenf Namen, die es nie gab.
 * Jede Suche mit gesetztem Bundesland lief damit garantiert leer aus, und die
 * Fehlersuche begann bei den Adaptern.
 *
 * Deshalb hier, beim Anlegen der Suche: der Moment, in dem noch jemand zusieht.
 */
export interface UnknownFilterKey {
  key: string
  /** Naechstliegende bekannte Schluessel, damit die Meldung handlungsfaehig ist. */
  didYouMean: string[]
}

export function findUnknownFilterKeys(
  filters: FilterNode,
  registry: SignalRegistry
): UnknownFilterKey[] {
  const known = new Set([
    ...CORE_FIELD_KEYS,
    ...registry.signalDefs().map((def) => def.key),
  ])

  const unknown = new Map<string, UnknownFilterKey>()

  const visit = (node: FilterNode): void => {
    if (isBranchNode(node)) {
      node.children.forEach(visit)
      return
    }
    if (isNotNode(node)) {
      visit(node.child)
      return
    }
    if (!isLeafNode(node)) return
    if (known.has(node.key) || unknown.has(node.key)) return

    unknown.set(node.key, { key: node.key, didYouMean: suggest(node.key, known) })
  }

  visit(filters)
  return [...unknown.values()]
}

/**
 * Bis zu drei Vorschlaege, gemessen an der Levenshtein-Distanz.
 *
 * Die Namen liegen nah beieinander (`geo.state` vs. `core.region`), und wer den
 * Filter gebaut hat, hat meist nicht geraten, sondern sich erinnert. Ein
 * Vorschlag verkuerzt die Suche von Stunden auf Sekunden - ohne ihn muss man
 * erst herausfinden, dass es eine Schluesselliste gibt.
 */
function suggest(key: string, known: Set<string>): string[] {
  const tail = key.includes(".") ? (key.split(".").pop() ?? key) : key

  return [...known]
    .map((candidate) => {
      const candidateTail = candidate.split(".").pop() ?? candidate
      // Der Teil nach dem Punkt traegt die Bedeutung: "geo.state" und
      // "core.region" haben keinen gemeinsamen Praefix, meinen aber dasselbe.
      return { candidate, distance: Math.min(levenshtein(key, candidate), levenshtein(tail, candidateTail)) }
    })
    .filter((entry) => entry.distance <= 4)
    .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate))
    .slice(0, 3)
    .map((entry) => entry.candidate)
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)

  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
      const insertion = (current[j - 1] ?? 0) + 1
      const deletion = (previous[j] ?? 0) + 1
      current[j] = Math.min(substitution, insertion, deletion)
    }
    previous = current
  }

  return previous[b.length] ?? Math.max(a.length, b.length)
}
