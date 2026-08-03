/**
 * Development seed: one workspace, one member, a couple of companies.
 *
 * Refuses to run against production. Playbooks and rubric fixtures arrive with M4
 * and M3 respectively - this is only enough to exercise the M0 endpoints.
 */
import {
  closeDb,
  initDb,
  users,
  withoutWorkspaceScope,
  workspaceMembers,
  workspaces,
} from "@alg/db"
import { companies } from "@alg/db"
import { loadEnv } from "@alg/shared"

const DEMO_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001"
const DEMO_USER_ID = "00000000-0000-4000-8000-000000000002"

async function main(): Promise<void> {
  const env = loadEnv()

  if (env.NODE_ENV === "production") {
    throw new Error("Refusing to seed a production database.")
  }

  const db = initDb({ connectionString: env.DATABASE_URL })

  await withoutWorkspaceScope(
    "Seeding creates the workspace itself, so no workspace scope exists yet.",
    async (database) => {
      await database
        .insert(workspaces)
        .values({ id: DEMO_WORKSPACE_ID, name: "Demo Workspace", slug: "demo" })
        .onConflictDoNothing()

      await database
        .insert(users)
        .values({ id: DEMO_USER_ID, email: "demo@averio.agency", displayName: "Demo" })
        .onConflictDoNothing()

      await database
        .insert(workspaceMembers)
        .values({ workspaceId: DEMO_WORKSPACE_ID, userId: DEMO_USER_ID, role: "owner" })
        .onConflictDoNothing()

      await database
        .insert(companies)
        .values([
          {
            workspaceId: DEMO_WORKSPACE_ID,
            targetType: "local_business",
            name: "Gasthaus Beispiel",
            nameNormalized: "gasthaus beispiel",
            city: "Linz",
            postalCode: "4020",
            countryCode: "AT",
          },
          {
            workspaceId: DEMO_WORKSPACE_ID,
            targetType: "company",
            name: "Muster Produktion GmbH",
            nameNormalized: "muster produktion",
            domain: "muster-produktion.at",
            website: "https://muster-produktion.at",
            city: "Wels",
            postalCode: "4600",
            countryCode: "AT",
          },
        ])
        .onConflictDoNothing()
    },
    db
  )

  console.log(`Seeded workspace ${DEMO_WORKSPACE_ID} with user ${DEMO_USER_ID}.`)
  await closeDb()
}

main().catch((error: unknown) => {
  console.error("Seed failed:", error)
  process.exit(1)
})
