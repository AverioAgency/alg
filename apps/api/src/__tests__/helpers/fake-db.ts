import { type Database } from "@alg/db"

/**
 * A stand-in for the Drizzle query builder, for middleware tests.
 *
 * Only the chains the auth middleware uses are modelled - select/from/where/limit
 * and insert/values/onConflictDoNothing(/returning). A real database would mean
 * testcontainers for what is fundamentally a decision table, and the decisions
 * are what can be wrong in that code, not the SQL.
 *
 * Predicates are opaque objects here, so rows are matched by inspecting the
 * values the middleware inserts rather than by evaluating the WHERE clause. That
 * is enough because each table is queried by exactly one key.
 */

export interface FakeWorkspace {
  id: string
  slug: string
}

export interface FakeState {
  workspaces: FakeWorkspace[]
  users: { id: string; email: string }[]
  members: { workspaceId: string; userId: string; role: string }[]
  /** Slug the caller is currently resolving; set by the test harness. */
  lookingForSlug: string
  /** User id the caller is currently resolving; set by the test harness. */
  lookingForUser: string
}

export function createFakeDb(seed: Partial<FakeState> = {}): {
  db: Database
  state: FakeState
} {
  const state: FakeState = {
    workspaces: seed.workspaces ?? [],
    users: seed.users ?? [],
    members: seed.members ?? [],
    lookingForSlug: seed.lookingForSlug ?? "",
    lookingForUser: seed.lookingForUser ?? "",
  }

  let counter = 1
  const nextUuid = (): string => `00000000-0000-4000-8000-${String(counter++).padStart(12, "0")}`

  /**
   * Reads the SQL table name off a Drizzle table object.
   *
   * It lives under a well-known symbol (`drizzle:Name`), not under `_.name` -
   * that field is a type-level artefact and is undefined at runtime. Looked up
   * by symbol description so the fake does not import Drizzle internals.
   */
  function tableName(table: unknown): string {
    if (typeof table !== "object" || table === null) return ""
    for (const symbol of Object.getOwnPropertySymbols(table)) {
      if (symbol.description === "drizzle:Name") {
        const value = Reflect.get(table, symbol)
        return typeof value === "string" ? value : ""
      }
    }
    return ""
  }

  const db = {
    select(_fields?: unknown) {
      return {
        from(table: unknown) {
          const name = tableName(table)
          return {
            where(_predicate: unknown) {
              return {
                async limit(_count: number) {
                  if (name === "workspaces") {
                    const match = state.workspaces.find((w) => w.slug === state.lookingForSlug)
                    return match ? [{ id: match.id }] : []
                  }
                  if (name === "workspace_members") {
                    const match = state.members.find((m) => m.userId === state.lookingForUser)
                    return match ? [{ role: match.role }] : []
                  }
                  return []
                },
              }
            },
          }
        },
      }
    },

    insert(table: unknown) {
      const name = tableName(table)
      return {
        values(row: Record<string, unknown>) {
          const apply = (): { id: string }[] => {
            if (name === "workspaces") {
              const slug = String(row.slug)
              if (state.workspaces.some((w) => w.slug === slug)) return []
              const created = { id: nextUuid(), slug }
              state.workspaces.push(created)
              return [{ id: created.id }]
            }
            if (name === "users") {
              const id = String(row.id)
              if (!state.users.some((u) => u.id === id)) {
                state.users.push({ id, email: String(row.email) })
              }
              return []
            }
            if (name === "workspace_members") {
              const userId = String(row.userId)
              if (!state.members.some((m) => m.userId === userId)) {
                state.members.push({
                  workspaceId: String(row.workspaceId),
                  userId,
                  role: String(row.role),
                })
              }
              return []
            }
            return []
          }

          // The insert is awaited either directly or after .returning(), so the
          // chain has to be thenable and carry the extra method.
          const result = {
            onConflictDoNothing(_target?: unknown) {
              const rows = apply()
              return {
                returning(_fields?: unknown) {
                  return Promise.resolve(rows)
                },
                then<T>(resolve: (value: { id: string }[]) => T) {
                  return Promise.resolve(resolve(rows))
                },
              }
            },
          }
          return result
        },
      }
    },
  }

  return { db: db as unknown as Database, state }
}
