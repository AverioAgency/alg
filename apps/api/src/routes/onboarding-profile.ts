import { eq } from "drizzle-orm"
import { withWorkspace, workspaces, type Database } from "@alg/db"
import { OnboardingProfileSchema, type OnboardingProfile } from "@alg/shared"

/**
 * Das Onboarding-Profil des Workspace.
 *
 * Liegt hier statt in einer einzelnen Route, weil zwei Stellen es brauchen und
 * aus verschiedenen Gruenden: die Rueckfragen fuellen daraus Region und Branche
 * vor, und `/rubrics/suggest` braucht es als Kontext - ohne zu wissen, wer
 * sucht und was er verkauft, entwirft das Modell eine Rubrik fuer "gute Firmen
 * im Allgemeinen" statt fuer "Firmen, die zu diesem Angebot passen".
 *
 * Ein unlesbares Profil ist null, kein Fehler: die Suche muss auch dann laufen,
 * wenn jemand von Hand etwas Ungueltiges in die Spalte geschrieben hat.
 */
export async function loadOnboardingProfile(
  ctx: Parameters<typeof withWorkspace>[0],
  db: Database
): Promise<OnboardingProfile | null> {
  const rows = await withWorkspace(
    ctx,
    async ({ tx }) =>
      tx
        .select({ onboarding: workspaces.onboarding })
        .from(workspaces)
        .where(eq(workspaces.id, ctx.workspaceId))
        .limit(1),
    db
  )

  const raw = rows[0]?.onboarding
  if (raw === null || raw === undefined) return null

  const parsed = OnboardingProfileSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}
