import { createHash, randomUUID } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { mkdir, rename, rm, stat, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import { pipeline } from "node:stream/promises"
import { Readable } from "node:stream"
import { eq } from "drizzle-orm"
import { files, withWorkspace, withoutWorkspaceScope, type Database } from "@alg/db"
import { DEFAULT_RETENTION_DAYS, type FileRef, type StorageUsage } from "@alg/shared"
import {
  FileNotFoundError,
  StorageLimitExceededError,
  type FileStorage,
  type PutInput,
} from "./file-storage.js"
import { buildRelativePath, mimeForExt, resolveWithinRoot } from "./paths.js"

export interface LocalFileStorageOptions {
  /** ALG_STORAGE_PATH. Mounted as a shared volume across api, worker and scraper. */
  root: string
  /** ALG_STORAGE_MAX_GB, converted to bytes. Soft limit. */
  maxBytes: number
  db: Database
  /** Injectable for deterministic tests. */
  now?: () => Date
}

/**
 * Filesystem-backed storage.
 *
 * Two invariants worth stating: writes are atomic (staged in .tmp/ on the same
 * filesystem, then renamed, so a worker crash never leaves a half-written PDF that
 * looks valid), and paths come exclusively from the files table.
 */
export class LocalFileStorage implements FileStorage {
  private readonly root: string
  private readonly maxBytes: number
  private readonly db: Database
  private readonly now: () => Date
  /** Cached disk usage; recomputed lazily since du over the tree is not free. */
  private usageCache: { value: StorageUsage; at: number } | null = null

  constructor(options: LocalFileStorageOptions) {
    this.root = options.root
    this.maxBytes = options.maxBytes
    this.db = options.db
    this.now = options.now ?? (() => new Date())
  }

  private tmpDir(): string {
    return join(this.root, ".tmp")
  }

  async put(input: PutInput): Promise<FileRef> {
    const fileId = randomUUID()
    const at = this.now()
    const relativePath = buildRelativePath({
      workspaceId: input.workspaceId,
      kind: input.kind,
      fileId,
      ext: input.ext,
      at,
    })

    const absolutePath = resolveWithinRoot(this.root, relativePath)
    const tmpPath = join(this.tmpDir(), `${fileId}.part`)

    await mkdir(this.tmpDir(), { recursive: true })
    await mkdir(dirname(absolutePath), { recursive: true })

    const hash = createHash("sha256")
    let sizeBytes = 0

    try {
      if (Buffer.isBuffer(input.data)) {
        hash.update(input.data)
        sizeBytes = input.data.byteLength
        await pipeline(Readable.from(input.data), createWriteStream(tmpPath, { flags: "wx" }))
      } else {
        const source = input.data
        source.on("data", (chunk: Buffer | string) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          hash.update(buf)
          sizeBytes += buf.byteLength
        })
        await pipeline(source, createWriteStream(tmpPath, { flags: "wx" }))
      }

      // rename() within the same filesystem is atomic, so readers never observe a
      // partially written file at the final path.
      await rename(tmpPath, absolutePath)
    } catch (error) {
      await unlink(tmpPath).catch(() => undefined)
      throw error
    }

    const expiresAt =
      input.expiresAt === null
        ? null
        : (input.expiresAt ?? addDays(at, DEFAULT_RETENTION_DAYS[input.kind]))

    const row = {
      id: fileId,
      workspaceId: input.workspaceId,
      kind: input.kind,
      relativePath,
      mime: input.mime ?? mimeForExt(input.ext),
      sizeBytes,
      checksum: hash.digest("hex"),
      expiresAt,
    }

    try {
      await withWorkspace(
        { workspaceId: input.workspaceId },
        async ({ tx, values }) => tx.insert(files).values(values(row)),
        this.db
      )
    } catch (error) {
      // Keep disk and database consistent: an orphaned file would linger until the
      // cleanup cron notices it, and the caller has no id to reference it by.
      await unlink(absolutePath).catch(() => undefined)
      throw error
    }

    this.usageCache = null

    return {
      id: fileId,
      workspaceId: input.workspaceId,
      kind: input.kind,
      relativePath,
      mime: row.mime,
      sizeBytes,
      checksum: row.checksum,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      createdAt: at.toISOString(),
    }
  }

  /**
   * Looks the row up without a workspace filter on purpose: callers (the route
   * handler, the cleanup cron) need the row's workspace_id to decide access, and
   * the id is an unguessable uuid. Authorization happens at the route.
   */
  private async findRow(id: string) {
    const [row] = await withoutWorkspaceScope(
      "File lookup by unguessable uuid; the caller needs the row's workspace_id in order to authorize access, so the filter cannot be applied here.",
      async (db) => db.select().from(files).where(eq(files.id, id)).limit(1),
      this.db
    )
    if (!row) throw new FileNotFoundError(id)
    return row
  }

  async get(id: string): Promise<Readable> {
    const row = await this.findRow(id)
    const absolutePath = resolveWithinRoot(this.root, row.relativePath)
    try {
      await stat(absolutePath)
    } catch {
      throw new FileNotFoundError(id)
    }
    return createReadStream(absolutePath)
  }

  async stat(id: string): Promise<{ size: number; mime: string; createdAt: Date }> {
    const row = await this.findRow(id)
    return { size: row.sizeBytes, mime: row.mime, createdAt: row.createdAt }
  }

  async delete(id: string): Promise<void> {
    const row = await this.findRow(id)
    const absolutePath = resolveWithinRoot(this.root, row.relativePath)
    await rm(absolutePath, { force: true })
    await withWorkspace(
      { workspaceId: row.workspaceId },
      async ({ tx, scope }) => tx.delete(files).where(scope(files, eq(files.id, id))),
      this.db
    )
    this.usageCache = null
  }

  /**
   * Sums size_bytes from the files table rather than walking the tree - it is the
   * same number for practical purposes and does not cost an O(n) stat sweep on
   * every health check.
   */
  async usage(): Promise<StorageUsage> {
    const CACHE_MS = 30_000
    const nowMs = this.now().getTime()
    if (this.usageCache && nowMs - this.usageCache.at < CACHE_MS) {
      return this.usageCache.value
    }

    const rows = await withoutWorkspaceScope(
      "Disk usage is a host-level metric for the health endpoint and is deliberately summed across all workspaces.",
      async (db) => db.select({ sizeBytes: files.sizeBytes }).from(files),
      this.db
    )
    const usedBytes = rows.reduce((sum, r) => sum + (r.sizeBytes ?? 0), 0)

    const value: StorageUsage = {
      usedBytes,
      maxBytes: this.maxBytes,
      usedPercent: this.maxBytes > 0 ? Number(((usedBytes / this.maxBytes) * 100).toFixed(2)) : 0,
      overSoftLimit: usedBytes > this.maxBytes,
    }

    this.usageCache = { value, at: nowMs }
    return value
  }

  /** Called before enqueueing screenshot work, which is the bulk of storage growth. */
  async assertCapacity(): Promise<void> {
    const current = await this.usage()
    if (current.overSoftLimit) {
      throw new StorageLimitExceededError(current.usedBytes, current.maxBytes)
    }
  }
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date.getTime())
  copy.setUTCDate(copy.getUTCDate() + days)
  return copy
}
