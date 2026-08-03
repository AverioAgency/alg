import { readdir, rm, stat } from "node:fs/promises"
import { join, relative } from "node:path"
import { lte } from "drizzle-orm"
import { files, withoutWorkspaceScope, type Database } from "@alg/db"
import { resolveWithinRoot } from "./paths.js"

/**
 * Reconciles disk and database. Runs on a schedule from the worker.
 *
 * Three cases, handled differently on purpose:
 *   - expired rows      -> delete file and row
 *   - file without row  -> delete the file (an interrupted put left it behind)
 *   - row without file  -> log only, never auto-delete; losing the row would
 *                          destroy the audit trail for something that may have
 *                          been removed by an operator or a restore gone wrong
 */

export interface CleanupReport {
  expiredDeleted: number
  orphanFilesDeleted: number
  missingFiles: string[]
  bytesReclaimed: number
}

export interface CleanupOptions {
  root: string
  db: Database
  now?: () => Date
  logger?: { info(obj: unknown, msg?: string): void; warn(obj: unknown, msg?: string): void }
}

export async function runStorageCleanup(options: CleanupOptions): Promise<CleanupReport> {
  const now = options.now ?? (() => new Date())
  const report: CleanupReport = {
    expiredDeleted: 0,
    orphanFilesDeleted: 0,
    missingFiles: [],
    bytesReclaimed: 0,
  }

  const expired = await withoutWorkspaceScope(
    "Retention sweep runs host-wide across every workspace by design.",
    async (db) =>
      db
        .select({
          id: files.id,
          relativePath: files.relativePath,
          sizeBytes: files.sizeBytes,
        })
        .from(files)
        .where(lte(files.expiresAt, now())),
    options.db
  )

  const knownPaths = new Set<string>()

  for (const row of expired) {
    try {
      const absolute = resolveWithinRoot(options.root, row.relativePath)
      await rm(absolute, { force: true })
      report.bytesReclaimed += row.sizeBytes ?? 0
      report.expiredDeleted++
    } catch (error) {
      options.logger?.warn({ fileId: row.id, error }, "failed to delete expired file")
    }
  }

  if (expired.length > 0) {
    await withoutWorkspaceScope(
      "Retention sweep deletes expired rows across every workspace by design.",
      async (db) => db.delete(files).where(lte(files.expiresAt, now())),
      options.db
    )
  }

  // Second pass: compare what is on disk against what the table knows about.
  const allRows = await withoutWorkspaceScope(
    "Orphan detection must compare the entire tree against the entire table.",
    async (db) => db.select({ relativePath: files.relativePath }).from(files),
    options.db
  )
  for (const row of allRows) knownPaths.add(row.relativePath)

  for await (const absolute of walk(options.root)) {
    const rel = relative(options.root, absolute).split("\\").join("/")
    // .tmp holds in-flight writes; a concurrent put would otherwise lose its staging file.
    if (rel.startsWith(".tmp/")) continue
    if (knownPaths.has(rel)) continue

    try {
      const info = await stat(absolute)
      // Only reap staging leftovers that are demonstrably not in flight.
      if (now().getTime() - info.mtimeMs < 60 * 60 * 1000) continue
      await rm(absolute, { force: true })
      report.orphanFilesDeleted++
      report.bytesReclaimed += info.size
    } catch (error) {
      options.logger?.warn({ path: rel, error }, "failed to delete orphan file")
    }
  }

  for (const row of allRows) {
    try {
      await stat(resolveWithinRoot(options.root, row.relativePath))
    } catch {
      report.missingFiles.push(row.relativePath)
    }
  }

  if (report.missingFiles.length > 0) {
    options.logger?.warn(
      { count: report.missingFiles.length },
      "database rows reference files that are missing on disk"
    )
  }

  return report
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walk(full)
    } else if (entry.isFile()) {
      yield full
    }
  }
}
