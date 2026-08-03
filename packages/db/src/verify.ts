import { sql } from "drizzle-orm"
import { createDb } from "./client.js"
import { withoutWorkspaceScope } from "./workspace.js"

/**
 * Operational check that the deployed backend really reaches its database.
 *
 * `/v1/ready` only proves that a `SELECT 1` succeeds. This goes further: the
 * schema has to be complete, the extensions have to be installed, writes have to
 * be permitted, and Postgres has to compute trigram similarity exactly the way
 * the in-memory dedupe cascade does - otherwise the same pair of companies would
 * merge on one path and stay separate on the other.
 *
 * Ships as a compiled module rather than a `node -e` one-liner: in a pnpm
 * workspace, `pg` and `drizzle-orm` resolve relative to packages/db, so an inline
 * script started from another directory cannot find them.
 *
 * Run:  docker compose exec api node /app/packages/db/dist/verify.js
 */

const EXPECTED_TABLES = [
  "workspaces",
  "users",
  "workspace_members",
  "companies",
  "contacts",
  "company_sources",
  "files",
  "audit_log",
  "idempotency_keys",
]

const REQUIRED_EXTENSIONS = ["pgcrypto", "pg_trgm"]

/** Value Postgres documents for similarity('word','two words'). */
const TRIGRAM_REFERENCE = 0.363636

/**
 * Every query here inspects the instance itself - catalogue tables, installed
 * extensions, a scratch row it removes again. None of it belongs to a workspace,
 * so the guard is bypassed deliberately and visibly rather than with an
 * eslint-disable.
 */
const REASON =
  "Operational database verification inspects the instance itself; no workspace context exists."

/** Narrows an unknown throw value without asserting it is an Error. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const ok = (msg: string): void => console.log(`  [32mok[0m   ${msg}`)
const bad = (msg: string): void => console.log(`  [31mFAIL[0m ${msg}`)
const info = (msg: string): void => console.log(`       ${msg}`)

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    bad("DATABASE_URL is not set")
    process.exitCode = 1
    return
  }

  const { db, pool } = createDb({ connectionString, max: 1 })
  let failures = 0

  try {
    console.log("\nDatabase verification\n")

    // 1. Connectivity
    await withoutWorkspaceScope(REASON, async (d) => d.execute(sql`select 1`), db)
    ok("connection established")

    // 2. Schema
    const tables = await withoutWorkspaceScope(
      REASON,
      async (d) =>
        d.execute<{ tablename: string }>(
          sql`select tablename from pg_tables where schemaname = 'public' order by 1`
        ),
      db
    )
    const present = tables.rows.map((r) => r.tablename)
    const missing = EXPECTED_TABLES.filter((t) => !present.includes(t))

    if (missing.length === 0) {
      ok(`all ${EXPECTED_TABLES.length} expected tables present`)
    } else {
      bad(`missing tables: ${missing.join(", ")}`)
      failures++
    }
    info(`found ${present.length}: ${present.join(", ")}`)

    // 3. Extensions
    const extensions = await withoutWorkspaceScope(
      REASON,
      async (d) => d.execute<{ extname: string }>(sql`select extname from pg_extension`),
      db
    )
    const installed = extensions.rows.map((r) => r.extname)
    for (const required of REQUIRED_EXTENSIONS) {
      if (installed.includes(required)) {
        ok(`extension ${required}`)
      } else {
        bad(`extension ${required} is missing`)
        failures++
      }
    }

    // 4. Write access. Cleans up after itself even when the delete would be
    //    skipped by an early throw.
    try {
      const inserted = await withoutWorkspaceScope(
        REASON,
        async (d) =>
          d.execute<{ id: string }>(
            sql`insert into workspaces (name, slug) values ('__verify__', '__verify__') returning id`
          ),
        db
      )
      const id = inserted.rows[0]?.id
      await withoutWorkspaceScope(
        REASON,
        async (d) => d.execute(sql`delete from workspaces where slug = '__verify__'`),
        db
      )
      ok(`write access (inserted and removed ${id})`)
    } catch (error) {
      bad(`write access denied: ${errorMessage(error)}`)
      failures++
    }

    // 5. Trigram parity with the in-memory cascade.
    const trigram = await withoutWorkspaceScope(
      REASON,
      async (d) => d.execute<{ s: number }>(sql`select similarity('word', 'two words') as s`),
      db
    )
    const similarity = Number(trigram.rows[0]?.s ?? -1)
    if (Math.abs(similarity - TRIGRAM_REFERENCE) < 0.0001) {
      ok(`trigram similarity matches the TypeScript implementation (${similarity})`)
    } else {
      bad(`trigram similarity is ${similarity}, expected ~${TRIGRAM_REFERENCE}`)
      info("in-memory dedupe and the SQL index would disagree on the same pair")
      failures++
    }

    console.log(
      failures === 0 ? "\n[32mAll checks passed.[0m\n" : `\n[31m${failures} check(s) failed.[0m\n`
    )
    if (failures > 0) process.exitCode = 1
  } catch (error) {
    bad(`verification aborted: ${errorMessage(error)}`)
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}

main().catch((error: unknown) => {
  console.error("Verification failed:", error)
  process.exit(1)
})
