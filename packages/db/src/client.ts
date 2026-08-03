import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import pg from "pg"
import * as schema from "./schema/index.js"

export type Database = NodePgDatabase<typeof schema>

let pool: pg.Pool | null = null
let database: Database | null = null

export interface DbOptions {
  connectionString: string
  max?: number
  /** Supabase pools through pgbouncer; keep statement timeouts explicit. */
  statementTimeoutMs?: number
}

function createPool(options: DbOptions): pg.Pool {
  return new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    statement_timeout: options.statementTimeoutMs ?? 30_000,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  })
}

/** Standalone instance, mainly for tests that manage their own lifecycle. */
export function createDb(options: DbOptions): { db: Database; pool: pg.Pool } {
  const created = createPool(options)
  return { db: drizzle(created, { schema }), pool: created }
}

/** Process-wide singleton. Services call initDb() once at boot. */
export function initDb(options: DbOptions): Database {
  if (database) return database
  pool = createPool(options)
  database = drizzle(pool, { schema })
  return database
}

export function getDb(): Database {
  if (!database) {
    throw new Error("Database not initialized. Call initDb() during service startup.")
  }
  return database
}

export async function closeDb(): Promise<void> {
  await pool?.end()
  pool = null
  database = null
}

export { schema }
