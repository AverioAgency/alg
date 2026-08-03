import { z } from "zod"

export const WorkspaceRoleSchema = z.enum(["owner", "admin", "member", "viewer"])

export type WorkspaceRole = z.infer<typeof WorkspaceRoleSchema>

/**
 * The authenticated request context. Attached to req.ctx by the auth middleware
 * and threaded through every DB call via withWorkspace().
 */
export const RequestContextSchema = z.object({
  userId: z.uuid(),
  workspaceId: z.uuid(),
  role: WorkspaceRoleSchema,
  email: z.string().nullable().optional(),
  requestId: z.string(),
})

export type RequestContext = z.infer<typeof RequestContextSchema>

/** Rank order for permission checks: higher index = fewer privileges. */
const ROLE_RANK: Record<WorkspaceRole, number> = {
  owner: 0,
  admin: 1,
  member: 2,
  viewer: 3,
}

export function hasAtLeastRole(actual: WorkspaceRole, required: WorkspaceRole): boolean {
  return ROLE_RANK[actual] <= ROLE_RANK[required]
}
