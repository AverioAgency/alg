import { describe, expect, it, vi } from "vitest"
import { eq, type SQL } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import { companies, files } from "../schema/index.js"
import {
  MissingWorkspaceError,
  WorkspaceScopeViolationError,
  withWorkspace,
  withoutWorkspaceScope,
} from "../workspace.js"
import { type Database } from "../client.js"

const WORKSPACE_A = "11111111-1111-1111-1111-111111111111"
const WORKSPACE_B = "22222222-2222-2222-2222-222222222222"

/** Minimal stand-in: the guard's contract is about scoping, not about SQL execution. */
function fakeDb(): Database {
  return {} as unknown as Database
}

/** Compiles a predicate to real SQL so assertions read against the emitted query. */
const dialect = new PgDialect()
function compile(condition: SQL): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(condition)
  return { sql: query.sql, params: query.params }
}

describe("withWorkspace", () => {
  it("hands the callback the workspace id it was given", async () => {
    const seen = await withWorkspace(
      { workspaceId: WORKSPACE_A },
      async (scope) => scope.workspaceId,
      fakeDb()
    )
    expect(seen).toBe(WORKSPACE_A)
  })

  it("builds a predicate that pins workspace_id", async () => {
    const condition = await withWorkspace(
      { workspaceId: WORKSPACE_A },
      async ({ scope }) => scope(companies),
      fakeDb()
    )

    const { sql, params } = compile(condition)
    expect(sql).toContain('"workspace_id"')
    // The id must be bound as a parameter, never interpolated into the string.
    expect(params).toContain(WORKSPACE_A)
    expect(sql).not.toContain(WORKSPACE_A)
  })

  it("ANDs additional conditions onto the workspace predicate", async () => {
    const condition = await withWorkspace(
      { workspaceId: WORKSPACE_A },
      async ({ scope }) => scope(files, eq(files.kind, "report")),
      fakeDb()
    )

    const { sql, params } = compile(condition)
    expect(sql).toContain('"workspace_id"')
    expect(sql).toContain('"kind"')
    expect(sql.toLowerCase()).toContain(" and ")
    expect(params).toStrictEqual([WORKSPACE_A, "report"])
  })

  it("keeps the workspace predicate even when extra conditions are undefined", async () => {
    const condition = await withWorkspace(
      { workspaceId: WORKSPACE_A },
      async ({ scope }) => scope(companies, undefined),
      fakeDb()
    )

    const { sql, params } = compile(condition)
    expect(sql).toContain('"workspace_id"')
    expect(params).toStrictEqual([WORKSPACE_A])
  })

  it("stamps workspace_id onto insert values so it cannot be forgotten", async () => {
    const row = await withWorkspace(
      { workspaceId: WORKSPACE_A },
      async ({ values }) => values({ name: "Testfirma", targetType: "company" }),
      fakeDb()
    )

    expect(row.workspaceId).toBe(WORKSPACE_A)
  })

  it("overrides a workspace id supplied by the caller", async () => {
    // A handler that copied workspaceId out of a request body must not be able to
    // write into another tenant.
    const row = await withWorkspace(
      { workspaceId: WORKSPACE_A },
      async ({ values }) => values({ name: "Testfirma", workspaceId: WORKSPACE_B }),
      fakeDb()
    )

    expect(row.workspaceId).toBe(WORKSPACE_A)
  })

  describe("refuses to run without a usable workspace", () => {
    const invalid = [undefined, null, "", "not-a-uuid", "1234", "  ", WORKSPACE_A.slice(0, -1)]

    for (const workspaceId of invalid) {
      it(`rejects ${JSON.stringify(workspaceId)}`, async () => {
        const fn = vi.fn()
        await expect(
          withWorkspace({ workspaceId: workspaceId as never }, fn, fakeDb())
        ).rejects.toBeInstanceOf(MissingWorkspaceError)
        // The callback must never run - a query that reached the database
        // unscoped would already have crossed tenants.
        expect(fn).not.toHaveBeenCalled()
      })
    }

    it("rejects a missing context object entirely", async () => {
      await expect(
        withWorkspace(undefined as never, async () => "unreachable", fakeDb())
      ).rejects.toBeInstanceOf(MissingWorkspaceError)
    })
  })

  it("refuses to scope a table that has no workspace_id column", async () => {
    // This is the deliberately-wrong query the milestone calls for: asking the guard
    // to scope something it cannot scope must fail loudly rather than silently
    // returning rows from every tenant.
    const tableWithoutWorkspace = { _: { name: "global_thing" } } as never

    await expect(
      withWorkspace(
        { workspaceId: WORKSPACE_A },
        async ({ scope }) => scope(tableWithoutWorkspace),
        fakeDb()
      )
    ).rejects.toBeInstanceOf(WorkspaceScopeViolationError)
  })
})

describe("withoutWorkspaceScope", () => {
  it("runs when given a substantive reason", async () => {
    const result = await withoutWorkspaceScope(
      "Health probe against the connection pool, no workspace context exists.",
      async () => "ran",
      fakeDb()
    )
    expect(result).toBe("ran")
  })

  it("refuses an empty or throwaway reason", async () => {
    await expect(withoutWorkspaceScope("", async () => "x", fakeDb())).rejects.toThrow()
    await expect(withoutWorkspaceScope("because", async () => "x", fakeDb())).rejects.toThrow()
  })
})
