import { createHmac, randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import { createDb } from "./client.js"
import { withoutWorkspaceScope } from "./workspace.js"

/**
 * Prepares everything a manual end-to-end test needs and prints the commands.
 *
 * Two things stand between a fresh deployment and a first search: there is no
 * workspace to scope anything to, and no JWT to authenticate with. Both are
 * fiddly to produce by hand - the token has to be signed with the project's
 * Supabase secret and carry the right claims - so this does it in one step.
 *
 * Idempotent: re-running reuses the same workspace rather than piling up copies.
 *
 * Run:  docker compose exec api node /app/packages/db/dist/smoke.js
 */

const DEMO_WORKSPACE_SLUG = "smoke-test"
const TOKEN_TTL_SECONDS = 24 * 60 * 60

/** Signs an HS256 JWT the way self-hosted Supabase does. */
function signJwt(payload: Record<string, unknown>, secret: string): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url")

  const header = encode({ alg: "HS256", typ: "JWT" })
  const body = encode(payload)
  const signature = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url")

  return `${header}.${body}.${signature}`
}

const REASON =
  "Smoke-test bootstrap creates the workspace itself, so no workspace scope exists yet."

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL
  const jwtSecret = process.env.SUPABASE_JWT_SECRET
  const baseUrl = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000"

  if (!connectionString || !jwtSecret) {
    console.error("DATABASE_URL and SUPABASE_JWT_SECRET must be set.")
    process.exitCode = 1
    return
  }

  const { db, pool } = createDb({ connectionString, max: 1 })

  try {
    const { workspaceId, userId, email } = await withoutWorkspaceScope(
      REASON,
      async (database) => {
        const existing = await database.execute<{ id: string }>(
          sql`select id from workspaces where slug = ${DEMO_WORKSPACE_SLUG} limit 1`
        )

        if (existing.rows[0]) {
          const wsId = existing.rows[0].id
          const member = await database.execute<{ user_id: string; email: string }>(
            sql`select m.user_id, u.email
                from workspace_members m
                join users u on u.id = m.user_id
                where m.workspace_id = ${wsId}
                limit 1`
          )
          const row = member.rows[0]
          if (row) {
            return { workspaceId: wsId, userId: row.user_id, email: row.email }
          }
        }

        const newWorkspaceId = existing.rows[0]?.id ?? randomUUID()
        const newUserId = randomUUID()
        const newEmail = `smoke+${newUserId.slice(0, 8)}@averio.agency`

        await database.execute(
          sql`insert into workspaces (id, name, slug)
              values (${newWorkspaceId}, 'Smoke Test', ${DEMO_WORKSPACE_SLUG})
              on conflict (slug) do nothing`
        )
        await database.execute(
          sql`insert into users (id, email, display_name)
              values (${newUserId}, ${newEmail}, 'Smoke Test')
              on conflict (email) do nothing`
        )
        await database.execute(
          sql`insert into workspace_members (workspace_id, user_id, role)
              values (${newWorkspaceId}, ${newUserId}, 'owner')
              on conflict do nothing`
        )

        return { workspaceId: newWorkspaceId, userId: newUserId, email: newEmail }
      },
      db
    )

    const now = Math.floor(Date.now() / 1000)
    const token = signJwt(
      {
        sub: userId,
        email,
        role: "authenticated",
        aud: "authenticated",
        iss: `${(process.env.SUPABASE_URL ?? "").replace(/\/$/, "")}/auth/v1`,
        iat: now,
        exp: now + TOKEN_TTL_SECONDS,
      },
      jwtSecret
    )

    console.log(`
Workspace and token ready. Valid for 24 hours.

  WORKSPACE_ID  ${workspaceId}
  USER_ID       ${userId}

Export these, then run the commands below:

export ALG_URL="${baseUrl}"
export WS="${workspaceId}"
export TOKEN="${token}"

# 1. Create a search (restaurants in Linz, via Overpass - free, no API key)
curl -sX POST "$ALG_URL/v1/searches" \\
  -H "authorization: Bearer $TOKEN" -H "x-workspace-id: $WS" \\
  -H "content-type: application/json" \\
  -d '{"name":"Restaurants Linz","spec":{"targetType":"local_business","limit":25,
       "filters":{"op":"and","children":[
         {"op":"eq","key":"core.category","value":"restaurant"},
         {"op":"within","key":"core.geo","value":{"bbox":[48.28,14.25,48.33,14.33]}}]}}}' | jq

# 2. Start it - returns 202 with a run_id
export SEARCH_ID="<id from step 1>"
curl -sX POST "$ALG_URL/v1/searches/$SEARCH_ID/run" \\
  -H "authorization: Bearer $TOKEN" -H "x-workspace-id: $WS" \\
  -H "content-type: application/json" -d '{}' | jq

# 3. Watch progress (Ctrl-C to stop)
export RUN_ID="<run_id from step 2>"
curl -N "$ALG_URL/v1/streams/$RUN_ID" \\
  -H "authorization: Bearer $TOKEN" -H "x-workspace-id: $WS"

# 4. The run's final counters
curl -s "$ALG_URL/v1/runs/$RUN_ID" \\
  -H "authorization: Bearer $TOKEN" -H "x-workspace-id: $WS" | jq

# 5. What landed in the database
curl -s "$ALG_URL/v1/companies?limit=5" \\
  -H "authorization: Bearer $TOKEN" -H "x-workspace-id: $WS" | jq
`)
  } catch (error) {
    console.error("Bootstrap failed:", error instanceof Error ? error.message : error)
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}

main().catch((error: unknown) => {
  console.error("Bootstrap failed:", error)
  process.exit(1)
})
