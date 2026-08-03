-- M3: scoring.
--
-- Forward-compatible: new tables only, nothing altered or dropped, so M1 and M2
-- code keeps running against this schema.

CREATE TABLE IF NOT EXISTS "rubrics" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" varchar(160) NOT NULL,
  "description" text,
  -- The whole Rubric contract as one document: criteria, llmCriteria, threshold.
  -- Stored as jsonb rather than normalized into rows because a rubric is edited
  -- and versioned as a unit - splitting it would buy nothing and cost a join on
  -- the hottest path in scoring.
  "definition" jsonb NOT NULL,
  -- Which target type this rubric's signals are valid for. A rubric written
  -- against local_business signals must not be offered for a person search.
  "target_type" varchar(24) NOT NULL,
  -- Set when the rubric came from a template, so the UI can show provenance and
  -- a later template fix can find its descendants.
  "template_slug" varchar(64),
  -- Bumped on every edit. lead_scores records the version it was computed with,
  -- so a stale score is recognizable rather than silently misleading.
  "version" integer DEFAULT 1 NOT NULL,
  "archived_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lead_scores" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "rubric_id" uuid NOT NULL REFERENCES "rubrics"("id") ON DELETE CASCADE,
  -- The rubric version this score was computed with. Without it a score from
  -- before an edit looks current.
  "rubric_version" integer NOT NULL,
  "total" integer NOT NULL,
  "qualified" boolean DEFAULT false NOT NULL,
  "threshold" integer NOT NULL,
  -- Per-criterion breakdown. A score without it is unusable: the user has to be
  -- able to see why a lead ranks where it does.
  "breakdown" jsonb NOT NULL,
  -- LLM assessment, or null when the stage did not run (no key, or the rubric
  -- has no llmCriteria). null and "scored zero" are different findings.
  "llm" jsonb,
  -- The user's verdict, set by hand. Feeds threshold calibration.
  "feedback" varchar(8),
  "feedback_at" timestamp with time zone,
  "scored_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scoring_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "rubric_id" uuid NOT NULL REFERENCES "rubrics"("id") ON DELETE CASCADE,
  "status" varchar(16) DEFAULT 'queued' NOT NULL,
  "companies_total" integer DEFAULT 0 NOT NULL,
  "companies_done" integer DEFAULT 0 NOT NULL,
  "qualified_count" integer DEFAULT 0 NOT NULL,
  -- How often the LLM stage actually ran. Zero with a configured key means every
  -- lead was rule-scored, which is worth being able to see.
  "llm_calls" integer DEFAULT 0 NOT NULL,
  "llm_input_tokens" integer DEFAULT 0 NOT NULL,
  "llm_output_tokens" integer DEFAULT 0 NOT NULL,
  "error_key" varchar(64),
  "error_detail" text,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rubrics_workspace_idx" ON "rubrics" ("workspace_id");
CREATE INDEX IF NOT EXISTS "rubrics_workspace_created_idx" ON "rubrics" ("workspace_id","created_at","id");
CREATE INDEX IF NOT EXISTS "rubrics_workspace_target_idx" ON "rubrics" ("workspace_id","target_type");

-- One current score per company and rubric: rescoring overwrites. The history
-- that matters lives in audit_log.
CREATE UNIQUE INDEX IF NOT EXISTS "lead_scores_company_rubric_key" ON "lead_scores" ("company_id","rubric_id");
CREATE INDEX IF NOT EXISTS "lead_scores_workspace_idx" ON "lead_scores" ("workspace_id");
-- The ranking query: qualified leads for one rubric, best first. total DESC
-- comes before the keyset tiebreaker so the index serves the sort directly.
CREATE INDEX IF NOT EXISTS "lead_scores_rubric_rank_idx" ON "lead_scores" ("workspace_id","rubric_id","total" DESC,"id");
-- Calibration reads only the hand-labelled rows, which are a small minority.
CREATE INDEX IF NOT EXISTS "lead_scores_feedback_idx" ON "lead_scores" ("workspace_id","rubric_id") WHERE "feedback" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "scoring_runs_workspace_idx" ON "scoring_runs" ("workspace_id");
CREATE INDEX IF NOT EXISTS "scoring_runs_workspace_created_idx" ON "scoring_runs" ("workspace_id","created_at","id");
