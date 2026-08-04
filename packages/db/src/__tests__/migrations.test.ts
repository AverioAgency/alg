import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * Eine Migration, die nicht im Journal steht, laeuft nie.
 *
 * Drizzle fuehrt aus, was in `meta/_journal.json` steht - nicht, was im Ordner
 * liegt. Eine von Hand geschriebene .sql-Datei ohne Journal-Eintrag wird beim
 * Deploy stillschweigend uebersprungen; auffallen wuerde es erst als HTTP 500,
 * wenn der neue Code eine Spalte liest, die es auf dem Server nicht gibt.
 *
 * Beinahe passiert mit 0005_dismiss_leads.
 */

const MIGRATIONS = join(fileURLToPath(new URL("../..", import.meta.url)), "migrations")

interface Journal {
  entries: { idx: number; tag: string; when: number }[]
}

function readJournal(): Journal {
  return JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as Journal
}

function sqlFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => name.replace(/\.sql$/, ""))
    .sort()
}

describe("migration journal", () => {
  it("lists every .sql file in the folder", () => {
    const tags = new Set(readJournal().entries.map((entry) => entry.tag))
    const missing = sqlFiles().filter((file) => !tags.has(file))

    expect(missing, `Nicht im Journal und damit tot: ${missing.join(", ")}`).toStrictEqual([])
  })

  it("has a file for every entry", () => {
    // Andersherum genauso schlimm: ein Eintrag ohne Datei laesst die Migration
    // beim Deploy abbrechen, statt nur nichts zu tun.
    const files = new Set(sqlFiles())
    const orphans = readJournal()
      .entries.map((entry) => entry.tag)
      .filter((tag) => !files.has(tag))

    expect(orphans, `Eintrag ohne .sql-Datei: ${orphans.join(", ")}`).toStrictEqual([])
  })

  it("keeps idx contiguous and ordered", () => {
    // Die Reihenfolge ist die Ausfuehrungsreihenfolge. Eine Luecke oder ein
    // Sprung heisst, dass jemand zwei Branches gemerged hat, ohne sie zu ordnen.
    const entries = readJournal().entries
    expect(entries.map((entry) => entry.idx)).toStrictEqual(entries.map((_, index) => index))
  })

  it("applies migrations in the order they were written", () => {
    const timestamps = readJournal().entries.map((entry) => entry.when)
    const sorted = [...timestamps].sort((a, b) => a - b)
    expect(timestamps).toStrictEqual(sorted)
  })
})
