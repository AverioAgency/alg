-- M2: the signal layer's storage.
--
-- Forward-compatible: new tables only, nothing altered or dropped, so M1 code
-- keeps running against this schema.

CREATE TABLE IF NOT EXISTS "enrichments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "provider_id" varchar(64) NOT NULL,
  -- Bumped when extraction logic changes; lets the cache invalidate exactly the
  -- affected rows rather than everything.
  "provider_version" varchar(32) NOT NULL,
  "values" jsonb NOT NULL,
  "source_url" text,
  "file_id" uuid,
  "error" text,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- fetched_at + the provider's ttlDays. A row past this is refetched.
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "enrichment_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "status" varchar(16) DEFAULT 'queued' NOT NULL,
  "plan" jsonb,
  "referenced_keys" jsonb,
  "companies_total" integer DEFAULT 0 NOT NULL,
  "companies_done" integer DEFAULT 0 NOT NULL,
  "cache_hits" integer DEFAULT 0 NOT NULL,
  "providers_run" integer DEFAULT 0 NOT NULL,
  "error_key" varchar(64),
  "error_detail" text,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
-- One current row per company and provider: a new run overwrites rather than
-- appends. The history that matters lives in audit_log.
CREATE UNIQUE INDEX IF NOT EXISTS "enrichments_company_provider_key" ON "enrichments" ("company_id","provider_id");
CREATE INDEX IF NOT EXISTS "enrichments_workspace_idx" ON "enrichments" ("workspace_id");
CREATE INDEX IF NOT EXISTS "enrichments_workspace_provider_idx" ON "enrichments" ("workspace_id","provider_id");
CREATE INDEX IF NOT EXISTS "enrichments_expires_idx" ON "enrichments" ("expires_at");

CREATE INDEX IF NOT EXISTS "enrichment_runs_workspace_idx" ON "enrichment_runs" ("workspace_id");
CREATE INDEX IF NOT EXISTS "enrichment_runs_workspace_created_idx" ON "enrichment_runs" ("workspace_id","created_at","id");
