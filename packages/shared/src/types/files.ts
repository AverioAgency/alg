import { z } from "zod"

/**
 * Storage bucket for an artifact. Drives both the on-disk layout and the
 * default retention window.
 */
export const FileKindSchema = z.enum(["screenshot", "report", "export", "crawl"])

export type FileKind = z.infer<typeof FileKindSchema>

export const FILE_KINDS = FileKindSchema.options

/** Default retention per kind, in days. Applied by the storage cleanup cron. */
export const DEFAULT_RETENTION_DAYS: Record<FileKind, number> = {
  screenshot: 90,
  report: 365,
  export: 30,
  crawl: 30,
}

export const FileRefSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  kind: FileKindSchema,
  /** Relative to ALG_STORAGE_PATH. Never built from user input - always from the DB. */
  relativePath: z.string().min(1),
  mime: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  /** sha256 hex of the contents, for integrity checks and dedupe. */
  checksum: z.string().min(1),
  expiresAt: z.iso.datetime().nullable().optional(),
  createdAt: z.iso.datetime(),
})

export type FileRef = z.infer<typeof FileRefSchema>

export const StorageUsageSchema = z.object({
  usedBytes: z.number().int().nonnegative(),
  maxBytes: z.number().int().nonnegative(),
  usedPercent: z.number().min(0),
  /** True once usage exceeds ALG_STORAGE_MAX_GB - new screenshot jobs pause. */
  overSoftLimit: z.boolean(),
})

export type StorageUsage = z.infer<typeof StorageUsageSchema>
