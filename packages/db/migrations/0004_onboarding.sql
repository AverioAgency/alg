-- M4: the onboarding profile.
--
-- Additive only: one nullable column, so code that predates it keeps running
-- against this schema.

-- A column on workspaces rather than a table of its own: there is exactly one
-- profile per workspace, it is read on nearly every search to pre-fill the
-- clarification answers, and a separate table would buy a join on that path in
-- exchange for nothing.
--
-- jsonb because the shape is the frontend's wizard, not ours. Steps 4-6
-- (channels, templates, compliance) have no ALG endpoints until M5; modelling
-- columns for them now would fix decisions M5 should still be free to make.
-- NULL means "never started", which is what makes the wizard offer itself.
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "onboarding" jsonb;
