-- M1: searches, their runs, and the dedupe provenance columns.
--
-- Forward-compatible on purpose: every column added here is nullable or has a
-- default, so the M0 code keeps running against this schema. Nothing is dropped.

CREATE TABLE IF NOT EXISTS "searches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "target_type" varchar(32) NOT NULL,
  "spec" jsonb NOT NULL,
  "sources" jsonb,
  "is_monitor" boolean DEFAULT false NOT NULL,
  "monitor_cron" varchar(64),
  "last_run_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "search_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  -- set null, not cascade: a run's history outlives the search definition.
  "search_id" uuid REFERENCES "searches"("id") ON DELETE SET NULL,
  "status" varchar(16) DEFAULT 'queued' NOT NULL,
  "spec" jsonb NOT NULL,
  "plan" jsonb,
  "entities_found" integer DEFAULT 0 NOT NULL,
  "entities_new" integer DEFAULT 0 NOT NULL,
  "entities_duplicate" integer DEFAULT 0 NOT NULL,
  "cost_cents" bigint DEFAULT 0 NOT NULL,
  "error_key" varchar(64),
  "error_detail" text,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "search_run_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "run_id" uuid NOT NULL REFERENCES "search_runs"("id") ON DELETE CASCADE,
  "sequence" integer NOT NULL,
  "type" varchar(32) NOT NULL,
  "payload" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
-- Dedupe provenance on companies. All nullable, so existing rows stay valid.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "dedupe_stage" varchar(16);
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "dedupe_confidence" double precision;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "first_seen_run_id" uuid;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "last_seen_at" timestamp with time zone;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "searches_workspace_idx" ON "searches" ("workspace_id");
CREATE INDEX IF NOT EXISTS "searches_workspace_created_idx" ON "searches" ("workspace_id","created_at","id");

CREATE INDEX IF NOT EXISTS "search_runs_workspace_idx" ON "search_runs" ("workspace_id");
CREATE INDEX IF NOT EXISTS "search_runs_workspace_search_idx" ON "search_runs" ("workspace_id","search_id");
CREATE INDEX IF NOT EXISTS "search_runs_workspace_status_idx" ON "search_runs" ("workspace_id","status");
CREATE INDEX IF NOT EXISTS "search_runs_workspace_created_idx" ON "search_runs" ("workspace_id","created_at","id");

-- Unique per run: the SSE stream resumes from a sequence number, so a duplicate
-- would make the resume point ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS "search_run_events_run_sequence_key" ON "search_run_events" ("run_id","sequence");
CREATE INDEX IF NOT EXISTS "search_run_events_workspace_idx" ON "search_run_events" ("workspace_id");

-- Backs stage 3 of the dedupe cascade (E.164 phone).
CREATE INDEX IF NOT EXISTS "companies_workspace_phone_idx" ON "companies" ("workspace_id","phone") WHERE "phone" IS NOT NULL;
