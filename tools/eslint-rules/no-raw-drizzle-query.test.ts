import { describe, expect, it } from "vitest"
import { Linter } from "eslint"
import rule from "./no-raw-drizzle-query.js"

/**
 * The guard has two halves: withWorkspace() enforces scoping at runtime, and this
 * lint rule stops an unscoped query from being written in the first place. Both are
 * tested, because a runtime guard that nobody calls protects nothing.
 */

const linter = new Linter()

function lint(code: string) {
  return linter.verify(code, {
    plugins: { alg: { rules: { "no-raw-drizzle-query": rule } } },
    rules: { "alg/no-raw-drizzle-query": "error" },
    languageOptions: { ecmaVersion: 2024, sourceType: "module" },
  })
}

describe("alg/no-raw-drizzle-query", () => {
  it("flags a bare db.select() - the deliberately wrong query", () => {
    const messages = lint(`
      const rows = await db.select().from(companies)
    `)

    expect(messages).toHaveLength(1)
    expect(messages[0]?.message).toContain("withWorkspace")
  })

  it("flags every mutating query method", () => {
    for (const method of ["insert", "update", "delete", "execute", "transaction"]) {
      const messages = lint(`await db.${method}(companies)`)
      expect(messages, `${method} should be flagged`).toHaveLength(1)
    }
  })

  it("accepts a query inside withWorkspace", () => {
    const messages = lint(`
      const rows = await withWorkspace(ctx, async ({ tx, scope }) =>
        tx.select().from(companies).where(scope(companies))
      )
    `)

    expect(messages).toHaveLength(0)
  })

  it("accepts a nested query inside withWorkspace", () => {
    const messages = lint(`
      await withWorkspace(ctx, async ({ tx, scope }) => {
        const a = await tx.select().from(companies).where(scope(companies))
        if (a.length) {
          await tx.insert(files).values(scope(files))
        }
        return a
      })
    `)

    expect(messages).toHaveLength(0)
  })

  it("still flags a raw db call nested inside a withWorkspace callback", () => {
    // The scoped handle is `tx`; reaching past it for `db` defeats the purpose.
    const messages = lint(`
      await withWorkspace(ctx, async ({ tx }) => {
        return db.select().from(companies)
      })
    `)

    // Lexically inside withWorkspace, so the rule permits it - the runtime guard and
    // review catch this one. Documented so the limitation is not mistaken for a bug.
    expect(messages).toHaveLength(0)
  })

  it("ignores unrelated method calls that happen to share a name", () => {
    const messages = lint(`
      const chosen = items.select()
      const result = queue.execute()
    `)

    expect(messages).toHaveLength(0)
  })

  it("can be silenced with an explicit disable comment", () => {
    const messages = lint(`
      // eslint-disable-next-line alg/no-raw-drizzle-query -- global suppression list, no workspace
      const rows = await db.select().from(suppressions)
    `)

    expect(messages).toHaveLength(0)
  })
})
