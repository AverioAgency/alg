/**
 * ALG has no RLS. Tenant isolation is enforced entirely in the application layer,
 * which means every Drizzle query must run inside a withWorkspace(ctx, fn) callback
 * that scopes it to a workspace_id.
 *
 * This rule flags any `db.select|insert|update|delete|execute|transaction(...)` call
 * that is not lexically enclosed by a withWorkspace() callback. The handle handed to
 * that callback is conventionally named `tx`, so `tx.select(...)` is always allowed.
 *
 * Escape hatch for genuinely workspace-less tables (workspaces itself, global
 * suppression lists, cron bookkeeping): wrap the query in
 *   withoutWorkspaceScope("<reason>", async (db) => ...)
 * which requires a written reason at runtime and stays greppable. An inline
 *   // eslint-disable-next-line alg/no-raw-drizzle-query -- <reason>
 * works too where wrapping is impractical.
 */

const QUERY_METHODS = new Set([
  "select",
  "selectDistinct",
  "insert",
  "update",
  "delete",
  "execute",
  "transaction",
  "query",
])

/** Identifiers that denote a raw, unscoped database handle. */
const RAW_DB_IDENTIFIERS = new Set(["db", "database", "drizzle", "conn", "connection"])

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require every Drizzle query to run inside withWorkspace() so workspace_id is always enforced.",
    },
    schema: [],
    messages: {
      unscoped:
        "Drizzle query `{{ name }}.{{ method }}()` runs outside withWorkspace(). ALG has no RLS - every query must be workspace-scoped. Wrap it in withWorkspace(ctx, (tx) => ...) or add an eslint-disable with a reason.",
    },
  },

  create(context) {
    /** Tracks how deeply we are nested inside a scoping wrapper's callback. */
    let withWorkspaceDepth = 0

    /** Both wrappers are acceptable: one enforces the scope, the other documents its absence. */
    const SCOPING_WRAPPERS = new Set(["withWorkspace", "withoutWorkspaceScope"])

    /** @param {any} node */
    function isWithWorkspaceCall(node) {
      const callee = node.callee
      if (!callee) return false
      if (callee.type === "Identifier") return SCOPING_WRAPPERS.has(callee.name)
      if (callee.type === "MemberExpression" && callee.property.type === "Identifier") {
        return SCOPING_WRAPPERS.has(callee.property.name)
      }
      return false
    }

    return {
      CallExpression(node) {
        if (isWithWorkspaceCall(node)) {
          withWorkspaceDepth++
          return
        }

        if (withWorkspaceDepth > 0) return

        const callee = node.callee
        if (callee.type !== "MemberExpression") return
        if (callee.property.type !== "Identifier") return
        if (!QUERY_METHODS.has(callee.property.name)) return

        // Only flag calls on an identifier that looks like a raw db handle.
        // `tx.select()` inside withWorkspace, or `someArray.query()`, are not our concern.
        const object = callee.object
        if (object.type !== "Identifier") return
        if (!RAW_DB_IDENTIFIERS.has(object.name)) return

        context.report({
          node,
          messageId: "unscoped",
          data: { name: object.name, method: callee.property.name },
        })
      },

      "CallExpression:exit"(node) {
        if (isWithWorkspaceCall(node)) {
          withWorkspaceDepth--
        }
      },
    }
  },
}
