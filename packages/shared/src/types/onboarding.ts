import { z } from "zod"
import { TargetTypeSchema } from "./target.js"

/**
 * What a workspace answered during onboarding.
 *
 * Two jobs, and the second is the one that matters. It records that onboarding
 * happened, so the wizard stops offering itself - but more importantly it feeds
 * the answers back into every later search: someone who said "Oberösterreich,
 * Handwerksbetriebe" should not be asked again on every query.
 *
 * Stored per workspace in ALG rather than in the frontend's own database,
 * because that is where searches are built. A copy in Nexoro would have to be
 * shipped along with every request to have any effect, which is the same data
 * travelling twice with two chances to disagree.
 *
 * Every field is optional. A half-finished profile is normal - the wizard can be
 * abandoned at any step - and a missing answer means "ask me", never "no".
 */

export const OnboardingProfileSchema = z.object({
  /** Step 1: who the workspace is. Context for the LLM stage, not a filter. */
  company: z
    .object({
      name: z.string().max(200).optional(),
      industry: z.string().max(200).optional(),
      website: z.string().max(300).optional(),
    })
    .optional(),

  /**
   * Step 2: what they sell.
   *
   * Free text on purpose. It is the input to POST /rubrics/suggest, and
   * constraining it to a taxonomy would lose exactly the detail that makes a
   * useful rubric ("Websites für Handwerksbetriebe unter 20 Mitarbeitern").
   */
  offer: z
    .object({
      description: z.string().max(4000).optional(),
      /** Rubric drafted from that description, if the user kept it. */
      rubricId: z.uuid().optional(),
    })
    .optional(),

  /** Step 3: who they are looking for. This is what pre-fills a search. */
  target: z
    .object({
      targetType: TargetTypeSchema.optional(),
      /** Region slug as used by the clarification questions, e.g. "oberoesterreich". */
      region: z.string().max(64).optional(),
      /** Category slugs from the shared vocabulary. */
      categories: z.array(z.string().max(64)).max(30).optional(),
      /** Playbook the workspace started from, for provenance in the UI. */
      playbookSlug: z.string().max(64).optional(),
    })
    .optional(),

  /**
   * Steps 4-6: channels, templates, compliance.
   *
   * Recorded but unused until M5 brings outreach. Kept as free-form rather than
   * modelled, because modelling a contract for features that do not exist yet
   * would fix decisions M5 should be free to make.
   */
  outreach: z.record(z.string(), z.unknown()).optional(),

  /**
   * Set when the user reached the end of the wizard.
   *
   * Null while it is still in progress, which is what makes the entry point
   * reappear after an abandoned run - the frontend shows the button on null and
   * hides it on a timestamp.
   */
  completedAt: z.iso.datetime().nullable().optional(),

  /** Last step the user was on, so an interrupted run can resume where it stopped. */
  lastStep: z.number().int().min(1).max(20).optional(),
})

export type OnboardingProfile = z.infer<typeof OnboardingProfileSchema>

/** True when the wizard ran to the end. The frontend hides its entry point on this. */
export function isOnboardingComplete(profile: OnboardingProfile | null | undefined): boolean {
  return Boolean(profile?.completedAt)
}
