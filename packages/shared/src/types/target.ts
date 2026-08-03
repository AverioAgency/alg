import { z } from "zod"

/**
 * What kind of thing a search is looking for. Everything downstream - which
 * discovery adapters run, which signal providers apply, which rubric criteria
 * are legal - keys off this.
 */
export const TargetTypeSchema = z.enum(["local_business", "company", "person", "list"])

export type TargetType = z.infer<typeof TargetTypeSchema>

export const TARGET_TYPES = TargetTypeSchema.options
