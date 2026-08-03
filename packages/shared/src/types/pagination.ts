import { z } from "zod"

/** Cursor pagination only - offsets drift when rows are inserted mid-scan. */
export const CursorPaginationQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export type CursorPaginationQuery = z.infer<typeof CursorPaginationQuerySchema>

export function paginatedSchema<T extends z.ZodType>(item: T) {
  return z.object({
    data: z.array(item),
    /** null when there is no further page. */
    nextCursor: z.string().nullable(),
  })
}

export interface Paginated<T> {
  data: T[]
  nextCursor: string | null
}

/**
 * Opaque keyset cursor. Encodes the sort key of the last row so the next page can
 * resume from it.
 *
 * Uses TextEncoder/atob/btoa rather than Buffer: this module is bundled into the
 * frontend, where Buffer does not exist.
 */
/** Exported for the SearchSpec encoder, which needs the same URL-safe alphabet. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function encodeCursor(value: Record<string, string | number>): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(value)))
}

export function decodeCursor(cursor: string): Record<string, string | number> | null {
  try {
    const json = new TextDecoder().decode(fromBase64Url(cursor))
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
    // eslint-disable-next-line no-restricted-syntax -- object-ness checked above; values stay opaque to callers
    return parsed as Record<string, string | number>
  } catch {
    return null
  }
}
