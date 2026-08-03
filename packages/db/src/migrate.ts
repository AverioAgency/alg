import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import { createDb } from "./client.js"

/**
 * Applies pending migrations. Run as a one-shot job before the new code rolls out -
 * migrations must be forward-compatible, never destructive in the same deploy as
 * the code that needs the column.
 */
async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to run migrations.")
  }

  const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations")
  const { db, pool } = createDb({ connectionString, max: 1 })

  try {
    await migrate(db, { migrationsFolder })
    console.log("Migrations applied.")
  } finally {
    await pool.end()
  }
}

main().catch((error: unknown) => {
  console.error("Migration failed:", error)
  process.exitCode = 1
})
